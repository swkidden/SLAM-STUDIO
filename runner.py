"""ROS bridge and owned algorithm process lifecycle."""
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
from urllib.parse import urlparse

class ProcessRunner:
    def start_ros(self, root, port):
        if self.config.get('runner'):
            self._ensure_master(root)
        folder = Path(root) / 'cache/live'
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (self.id + '.json')
        path.write_text(json.dumps(dict(self.config, session=self.id, endpoint=f'http://127.0.0.1:{port}')))
        self.log_path = folder / (self.id + '.log')
        setup = Path('/opt/ros') / os.environ.get('ROS_DISTRO','noetic') / 'setup.bash'
        env = self._environment(root, dict(setup=[str(setup)] if setup.is_file() else []))
        with self.log_path.open('w') as log:
            self.process = subprocess.Popen(['/usr/bin/python3', str(Path(root)/'tools/ros_live.py'), str(path)],
                                            env=env, stdout=log, stderr=log, start_new_session=True)
        if self.config.get('runner'):
            self.start_runner(root)

    def _master_ready(self, uri):
        try:
            import xmlrpc.client
            class MasterTransport(xmlrpc.client.Transport):
                def make_connection(self, host):
                    connection = super().make_connection(host)
                    connection.timeout = 0.5
                    return connection
            return xmlrpc.client.ServerProxy(uri, allow_none=True, transport=MasterTransport()).getPid('/slam_studio')[0] == 1
        except Exception:
            return False

    def _stop_process(self, process, timeout=4):
        if process and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=timeout)

    def _environment(self, root, spec):
        env = dict(os.environ)
        env.update(ROS_MASTER_URI=self.config['ros_master_uri'], ROS_HOSTNAME='localhost')
        env.pop('ROS_IP', None)
        setup = spec.get('setup', [])
        if not setup:
            default_setup = Path('/opt/ros') / os.environ.get('ROS_DISTRO','noetic') / 'setup.bash'
            if default_setup.is_file(): setup = [str(default_setup)]
        if setup:
            script = 'for f in "$@"; do source "$f"; done; env -0'
            result = subprocess.run(['/bin/bash', '-c', script, 'slam-studio', *setup],
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
            env = dict(line.split(b'=', 1) for line in result.stdout.split(b'\0') if b'=' in line)
            env = {k.decode(): v.decode(errors='surrogateescape') for k, v in env.items()}
        env.update(spec.get('env', {}))
        env['ROS_MASTER_URI'] = self.config['ros_master_uri']
        env.setdefault('ROS_HOSTNAME', 'localhost')
        return env

    def _ensure_master(self, root):
        runner = self.config['runner']
        uri = self.config['ros_master_uri']
        if not self._master_ready(uri):
            if not runner.get('auto_master', True):
                raise RuntimeError('ROS master is unavailable and auto_master is disabled')
            parsed = urlparse(uri)
            if parsed.hostname not in ('localhost', '127.0.0.1'):
                raise ValueError('auto_master only starts a local ROS master')
            folder = Path(root) / 'cache' / 'live' / self.id
            folder.mkdir(parents=True, exist_ok=True)
            master_log = (folder / 'roscore.log').open('w')
            script = 'import socket,sys,roslaunch; socket.setdefaulttimeout(2); roslaunch.main(["roscore","--core","-p",sys.argv[1]])'
            self.master_process = subprocess.Popen(['/usr/bin/python3', '-u', '-c', script, str(parsed.port or 11311)],
                                                   env=self._environment(root, dict(setup=[str(Path('/opt/ros') / os.environ.get('ROS_DISTRO','noetic') / 'setup.bash')])), stdout=master_log,
                                                   stderr=subprocess.STDOUT, start_new_session=True)
            for _ in range(30):
                if self._master_ready(uri):
                    break
                if self.master_process.poll() is not None:
                    raise RuntimeError('Local roscore failed; see '+str(folder/'roscore.log'))
                time.sleep(.2)
            else:
                raise RuntimeError('Local roscore did not become ready')

    def start_runner(self, root):
        runner = self.config['runner']
        uri = self.config['ros_master_uri']
        folder = Path(root) / 'cache' / 'live' / self.id
        folder.mkdir(parents=True, exist_ok=True)
        if not self._master_ready(uri):
            self._ensure_master(root)

        try:
            for index, spec in enumerate(runner['commands']):
                log = (folder / (spec.get('id', f'algorithm_{index}') + '.log')).open('w')
                env = self._environment(root, spec)
                process = subprocess.Popen(spec['argv'], cwd=spec.get('cwd') or root, env=env,
                                           stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                self.runner_processes.append((spec.get('id', f'algorithm_{index}'), process))
            time.sleep(runner.get('startup_delay', 1.0))
            failed = [(name, proc.returncode) for name, proc in self.runner_processes if proc.poll() is not None]
            if failed:
                raise RuntimeError('Algorithm exited during startup: '+', '.join(f'{n} ({c})' for n,c in failed))
            bag = runner.get('bag')
            if bag:
                argv = ['rosbag', 'play', bag['path'], '--rate', str(bag.get('rate', 1.0)),
                        '--start', str(bag.get('start', 0.0))]
                if bag.get('duration', -1) > 0:
                    argv += ['--duration', str(bag['duration'])]
                if bag.get('loop', False):
                    argv.append('--loop')
                if bag.get('clock', False):
                    argv.append('--clock')
                if bag.get('topics'):
                    argv += ['--topics', *bag['topics']]
                bag_log = (folder / 'rosbag_play.log').open('w')
                self.bag_process = subprocess.Popen(argv, env=self._environment(root, {}), cwd=root,
                                                    stdout=bag_log, stderr=subprocess.STDOUT, start_new_session=True)
            self.runner_status = 'playing' if bag else 'running'
            self._set_metadata('status', self.runner_status)
            self.runner_thread = threading.Thread(target=self._watch_runner, args=(root,), daemon=True)
            self.runner_thread.start()
        except Exception:
            self._stop_runner_processes()
            self._stop_process(self.master_process)
            self.master_process = None
            raise

    def _stop_runner_processes(self):
        with self.runner_stop_lock:
            bag, self.bag_process = self.bag_process, None
            processes, self.runner_processes = self.runner_processes, []
        running = [p for p in [bag, *(process for _, process in processes)]
                   if p and p.poll() is None]
        for process in running:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 4
        pending = []
        for process in running:
            try:
                process.wait(timeout=max(0, deadline-time.monotonic()))
            except subprocess.TimeoutExpired:
                pending.append(process)
        for process in pending:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for process in pending:
            process.wait()

    def _watch_runner(self, root):
        status, error = 'complete', ''
        bag = self.bag_process
        while ((bag and bag.poll() is None) or
               (not bag and any(process.poll() is None for _, process in self.runner_processes))):
            with self.lock:
                if self.runner_status == 'stopped':
                    status = 'stopped'
                    break
            dead = [(name, proc.returncode) for name, proc in self.runner_processes
                    if proc.poll() is not None and (proc.returncode != 0 or bag)]
            if dead:
                status = 'error'
                error = 'Algorithm process exited: '+', '.join(f'{n} ({c})' for n,c in dead)
                break
            if self.process and self.process.poll() is not None:
                status = 'error'
                error = 'ROS live bridge exited during bag playback'
                break
            time.sleep(.2)
        if status == 'complete' and bag and bag.returncode:
            status = 'error'
            error = f'rosbag play exited with code {bag.returncode}'
        if status == 'complete' and bag:
            deadline = time.monotonic() + self.config['runner']['drain_delay']
            while time.monotonic() < deadline:
                with self.lock:
                    if self.runner_status == 'stopped':
                        status = 'stopped'
                        break
                dead = [(name, proc.returncode) for name, proc in self.runner_processes if proc.poll() is not None]
                if dead:
                    status = 'error'
                    error = 'Algorithm process exited while flushing final messages: '+', '.join(f'{n} ({c})' for n,c in dead)
                    break
                if self.process and self.process.poll() is not None:
                    status = 'error'
                    error = 'ROS live bridge exited while flushing final messages'
                    break
                time.sleep(.05)
        self._stop_runner_processes()
        self._stop_process(self.process)
        self.process = None
        self._stop_process(self.master_process)
        self.master_process = None
        with self.lock:
            self.ended = True
            if self.runner_status != 'stopped':
                self.runner_status = status
                self.runner_error = error
                self._set_metadata('status', status)
                self._set_metadata('error', error)

