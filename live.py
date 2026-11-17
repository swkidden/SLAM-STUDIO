"""Bounded live streams. Transport and display do not control the estimator."""
import base64
from collections import deque
import copy
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlparse
import uuid

import cv2
import numpy as np

POSE_TYPES = ('nav_msgs/Odometry', 'geometry_msgs/PoseStamped', 'geometry_msgs/PoseWithCovarianceStamped',
              'geometry_msgs/TransformStamped', 'nav_msgs/Path')
IMAGE_TYPES = ('sensor_msgs/Image', 'sensor_msgs/CompressedImage')


def finite(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('Timestamps and poses must be finite')
    return value


from runner import ProcessRunner
from archive import reader, image as archive_image
from debug_stream import validate_samples, relative_samples, load_samples


class LiveSession(ProcessRunner):
    def __init__(self, config, root):
        self.config = copy.deepcopy(config)
        self.id = 'live_' + uuid.uuid4().hex
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.events = deque(maxlen=1024)
        self.process = None
        self.master_process = None
        self.runner_processes = []
        self.bag_process = None
        self.runner_thread = None
        self.runner_stop_lock = threading.Lock()
        self.runner_status = 'starting' if config.get('runner') else 'attached'
        self.runner_error = ''
        self.recording_saved = bool(config.get('save_recording', False))
        self.archive_closed = False
        self.log_path = None
        self.ended = False
        self.epoch = None
        self.latest = None
        self.received_at = None
        self.revision = 0
        self.generation = 0
        self.next_frame = 0
        self.error = ''
        self.counts = dict(poses=0, frames=0, dropped=0)
        self.poses = {s['id']: deque() for s in config['tracks']}
        self.frames = [deque() for _ in config['cameras']]
        self.debug_samples = {"diagnostics": deque(maxlen=6000), "markers": deque(maxlen=6000)}
        self.marker_state = {}
        self.marker_clears = {}
        self.frame_bytes = 0
        archive_dir = Path(root) / 'cache' / 'recordings'
        archive_dir.mkdir(parents=True, exist_ok=True)
        self.archive_path = archive_dir / (self.id + '.sqlite')
        self.archive = sqlite3.connect(self.archive_path, check_same_thread=False)
        self.archive.execute('PRAGMA journal_mode=WAL')
        self.archive.execute('PRAGMA synchronous=NORMAL')
        self.archive.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        self.archive.execute('CREATE TABLE poses(track TEXT, stamp REAL, x REAL, y REAL, z REAL, qx REAL, qy REAL, qz REAL, qw REAL, PRIMARY KEY(track,stamp))')
        self.archive.execute('CREATE TABLE frames(camera INTEGER, frame_id INTEGER, stamp REAL, jpeg BLOB, width INTEGER, height INTEGER, PRIMARY KEY(camera,frame_id))')
        self.archive.execute('CREATE INDEX frame_time ON frames(camera,stamp)')
        self.archive.execute('CREATE TABLE debug_samples(id INTEGER PRIMARY KEY, kind TEXT, stamp REAL, payload TEXT)')
        self.archive.execute('CREATE INDEX debug_time ON debug_samples(kind, stamp)')
        self._set_metadata('config', config)
        self._set_metadata('status', self.runner_status)
        self._set_metadata('saved', self.recording_saved)
        self._set_metadata('epoch', None)
        self._set_metadata('counts', self.counts)
        self._set_metadata('temporary_format', 1)
        self._set_metadata('owner_pid', os.getpid())

    def _set_metadata(self, key, value, commit=True):
        with self.lock:
            self.archive.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',
                                 (key, json.dumps(value, separators=(',', ':'))))
            if commit: self.archive.commit()

    def save_recording(self):
        with self.lock:
            if self.archive_closed or not self.archive_path.exists():
                raise ValueError('This run is no longer available to save')
            self.recording_saved = True
            self._set_metadata('saved', True)
            self.archive.commit()
        return dict(id=self.id, saved=True)

    def _discard_recording_if_unsaved(self):
        with self.lock:
            if self.recording_saved or self.archive_closed:
                return
            self.archive.commit()
            self.archive.close()
            self.archive_closed = True
        for suffix in ('', '-wal', '-shm'):
            Path(str(self.archive_path) + suffix).unlink(missing_ok=True)

    def stop(self):
        with self.lock:
            self.ended = True
            proc = self.process
            if self.config.get('runner') and self.runner_status in ('starting', 'playing', 'running'):
                self.runner_status = 'stopped'
                self._set_metadata('status', self.runner_status)
            elif not self.config.get('runner') and self.runner_status == 'attached':
                self.runner_status = 'stopped'
                self._set_metadata('status', self.runner_status)
        self._stop_runner_processes()
        self._stop_process(proc)
        self.process = None
        self._stop_process(self.master_process)
        self.master_process = None
        if self.runner_thread and self.runner_thread is not threading.current_thread():
            self.runner_thread.join(timeout=20)
        with self.changed:
            self.revision += 1
            self.changed.notify_all()

    def reset(self):
        with self.lock:
            for values in self.poses.values(): values.clear()
            for frames in self.frames: frames.clear()
            self.frame_bytes = 0
            self.epoch = self.latest = self.received_at = None
            self.generation += 1
            self.revision += 1
            self.counts = dict(poses=0, frames=0, dropped=0)
            self.archive.execute('DELETE FROM poses')
            self.archive.execute('DELETE FROM frames')
            self.archive.execute('DELETE FROM debug_samples')
            for samples in self.debug_samples.values(): samples.clear()
            self.marker_state.clear()
            self.marker_clears.clear()
            self.events.clear()
            self._set_metadata('epoch', None, commit=False)
            self._set_metadata('counts', self.counts)
            self.changed.notify_all()

    def push(self, batch):
        poses, frames = [], []
        if not isinstance(batch,dict) or not isinstance(batch.get('transport_counts',{}),dict): raise ValueError('Expected batch with transport counters')
        if not isinstance(batch, dict) or any(not isinstance(batch.get(k, []), list) for k in ('poses', 'frames')):
            raise ValueError('Expected poses and frames arrays')
        if len(batch.get('poses', [])) > 2000 or len(batch.get('frames', [])) > 4:
            raise ValueError('Batch too large')
        debug = {key: validate_samples(batch.get(key, []), markers=key == "markers") for key in ("diagnostics", "markers")}
        for p in batch.get('poses', []):
            if not isinstance(p, dict): raise ValueError('Expected a pose object')
            if p['track'] not in self.poses: raise ValueError('Unknown track')
            if p.get('frame_id', self.config['frame_id']) != self.config['frame_id']:
                raise ValueError('Pose frame_id must match the configured world frame')
            xyz, q = [finite(v) for v in p['position']], [finite(v) for v in p['orientation']]
            if len(xyz) != 3 or len(q) != 4: raise ValueError('Expected xyz and Hamilton xyzw')
            norm = math.sqrt(sum(v*v for v in q))
            if not math.isfinite(norm) or norm < 1e-10: raise ValueError('Invalid quaternion')
            poses.append((p['track'], [finite(p['stamp']), *xyz, *(v/norm for v in q)]))
        for f in batch.get('frames', []):
            if not isinstance(f, dict): raise ValueError('Expected a frame object')
            camera = int(f['camera'])
            if not 0 <= camera < len(self.frames): raise ValueError('Unknown camera')
            jpg = base64.b64decode(f['jpeg'], validate=True)
            if not 0 < len(jpg) <= 512*1024: raise ValueError('JPEG must be at most 512 KiB')
            if not jpg.startswith(b'\xff\xd8'): raise ValueError('Expected JPEG')
            img = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)
            if img is None or max(img.shape[:2]) > 4096: raise ValueError('Invalid or oversized image')
            frames.append((camera, finite(f['stamp']), jpg, img.shape[1], img.shape[0]))
        with self.lock:
            if self.ended: raise ValueError('Live session is stopped')
            motion_stamps = [p[1][0] for p in poses] + [f[1] for f in frames]
            stamps = motion_stamps + [s['stamp'] for values in debug.values() for s in values]
            if not stamps: return
            if motion_stamps and self.latest is not None and max(motion_stamps) < self.latest - 1:
                self.reset()
            if self.epoch is None: self.epoch = min(stamps)
            accepted = False
            saved_poses, saved_frames = [], []
            for track, row in poses:
                history = self.poses[track]
                if history and row[0] <= history[-1][0]: self.counts['dropped'] += 1; continue
                history.append(row); self.counts['poses'] += 1; accepted = True
                saved_poses.append((track, *row))
            for camera, stamp, jpg, width, height in frames:
                history = self.frames[camera]
                if history and stamp <= history[-1][1]: self.counts['dropped'] += 1; continue
                history.append((self.next_frame, stamp, jpg, width, height))
                saved_frames.append((camera, self.next_frame, stamp, jpg, width, height))
                self.next_frame += 1; self.frame_bytes += len(jpg)
                self.counts['frames'] += 1; accepted = True
            for key, samples in debug.items():
                samples.sort(key=lambda s: s['stamp'])
                self.debug_samples[key].extend(samples)
                for sample in samples:
                    self.archive.execute('INSERT INTO debug_samples(kind,stamp,payload) VALUES(?,?,?)',
                                         (key, sample['stamp'], json.dumps(sample, allow_nan=False)))
            for sample in debug['markers']:
                key = (sample['source'], sample['name'], sample.get('id', 0))
                if sample.get('action') == 'clear':
                    previous = self.marker_clears.get(sample['source'])
                    if previous is None or previous['stamp'] <= sample['stamp']:
                        self.marker_clears[sample['source']] = sample
                    self.marker_state = {k:v for k,v in self.marker_state.items() if k[0] != sample['source'] or v['stamp'] > sample['stamp']}
                elif key not in self.marker_state or self.marker_state[key]['stamp'] <= sample['stamp']:
                    self.marker_state[key] = sample
            if len(self.marker_state) > 6000:
                self.marker_state = dict(sorted(self.marker_state.items(), key=lambda pair: pair[1]['stamp'])[-6000:])
            if accepted or any(debug.values()):
                self.latest = max(stamps + ([self.latest] if self.latest is not None else []) + [v[-1][0] for v in self.poses.values() if v] + [v[-1][1] for v in self.frames if v])
                self.received_at = time.monotonic()
                cutoff = self.latest-self.config['history_seconds']
                for values in self.poses.values():
                    while values and (len(values) > self.config['max_poses'] or values[0][0] < cutoff): values.popleft()
                for values in self.frames:
                    while values and (len(values) > self.config['max_frames'] or values[0][1] < cutoff):
                        self.frame_bytes -= len(values.popleft()[2])
                while self.frame_bytes > 32*1024*1024:
                    oldest = min((v for v in self.frames if v), key=lambda v: v[0][0])
                    self.frame_bytes -= len(oldest.popleft()[2])
            for key, value in batch.get('transport_counts', {}).items():
                if key in ('source_poses','source_frames','bridge_dropped_poses','bridge_dropped_frames') and isinstance(value,int) and value>=0:
                    self.counts[key] = value
            self.counts['archived_poses'] = self.counts['poses']
            self.counts['archived_frames'] = self.counts['frames']
            if saved_poses:
                self.archive.executemany('INSERT OR IGNORE INTO poses VALUES(?,?,?,?,?,?,?,?,?)', saved_poses)
            if saved_frames:
                self.archive.executemany('INSERT OR IGNORE INTO frames VALUES(?,?,?,?,?,?)', saved_frames)
            if saved_poses or saved_frames or any(debug.values()):
                self._set_metadata('epoch', self.epoch, commit=False)
                self._set_metadata('counts', self.counts, commit=False)
                self.archive.commit()
            self.revision += 1
            self.events.append(dict(cursor=self.revision, generation=self.generation,
                poses=[[t, row[0]-self.epoch, *row[1:]] for t, *row in saved_poses],
                frames=[[c, fid, stamp-self.epoch, w, h] for c, fid, stamp, jpg, w, h in saved_frames],
                **{key: relative_samples(samples, self.epoch) for key, samples in debug.items()}))
            self.changed.notify_all()

    def updates(self, cursor, generation):
        with self.changed:
            if cursor == self.revision and generation == self.generation:
                self.changed.wait(timeout=1)
            if generation != self.generation or not self.events or cursor < self.events[0]['cursor']-1:
                return dict(kind='snapshot', cursor=self.revision, data=self.snapshot())
            return dict(kind='delta', cursor=self.revision, generation=self.generation,
                        updates=[v for v in self.events if v['cursor'] > cursor],
                        status=self.snapshot_status(), counts=dict(self.counts),
                        duration=max(0,(self.latest or self.epoch or 0)-(self.epoch or 0)),
                        epoch=self.epoch or 0, runner_status=self.runner_status,
                        recording_saved=self.recording_saved, error=self.runner_error or self.error)

    def snapshot_status(self):
        if self.ended: return 'stopped'
        if self.process and self.process.poll() is not None:
            self.error = self.log_path.read_text(errors='replace')[-1200:]
            return 'error'
        return 'waiting' if self.received_at is None else 'receiving' if time.monotonic()-self.received_at < 3 else 'stale'

    def frame(self, camera, index):
        with self.lock:
            if not 0 <= camera < len(self.frames): raise ValueError('Unknown camera')
            for f in self.frames[camera]:
                if f[0] == index: return f[2]
        return archive_image(self.archive_path, camera, frame_id=index)

    def frame_at(self, camera, stamp):
        if not 0 <= camera < len(self.frames): raise ValueError('Unknown camera')
        return archive_image(self.archive_path, camera, stamp=finite(stamp), epoch=self.epoch or 0)

    def snapshot(self):
        with self.lock:
            status = self.snapshot_status()
            epoch = self.epoch or 0
            tracks = [dict(s, poses=[[p[0]-epoch, *p[1:]] for p in self.poses[s['id']]], rmse=None, errors=[])
                      for s in self.config['tracks']]
            cameras = [dict(topic=s['topic'], role=s.get('role', 'camera'), label=s.get('label', s['topic']),
                            stamps=[f[1]-epoch for f in values], frame_ids=[f[0] for f in values],
                            width=values[-1][3] if values else 752, height=values[-1][4] if values else 480, count=len(values))
                       for s, values in zip(self.config['cameras'], self.frames)]
            duration = max(0, (self.latest or epoch)-epoch)
            primary = next((t for t in tracks if not t.get('truth')), tracks[0])
            last = [primary['poses'][-1][0]] if primary['poses'] else []
            if cameras and cameras[0]['stamps']: last.append(cameras[0]['stamps'][-1])
            starts = [t['poses'][0][0] for t in tracks if t['poses']]
            return dict(id=self.id, live=True, generation=self.generation, revision=self.revision,
                        status=status, error=self.error, counts=dict(self.counts), epoch=epoch, duration=duration,
                        recording_id=self.id, recording_path=str(self.archive_path),
                        recording_saved=self.recording_saved,
                        runner_status=self.runner_status, runner_error=self.runner_error,
                        start=0, time=max(0, cameras[0]['stamps'][-1] if cameras and cameras[0]['stamps'] else max(last,default=duration)),
                        diagnostics=relative_samples(self.debug_samples["diagnostics"], epoch),
                        markers=relative_samples([*self.marker_clears.values(), *self.marker_state.values(), *self.debug_samples["markers"]], epoch),
                        tracks=tracks, cameras=cameras, max_gap=self.config['max_pose_gap'], project=self.config)

    def close(self):
        self.stop()
        self._discard_recording_if_unsaved()
        with self.lock:
            if not self.archive_closed:
                self.archive.commit()
                self.archive.close()
                self.archive_closed = True


class LiveHub:
    def __init__(self, root=None):
        self.sessions = {}
        self.lock = threading.Lock()
        self.root = Path(root) if root else Path(tempfile.mkdtemp(prefix='slam-studio-live-'))

    def cleanup_temporary(self):
        folder = self.root / 'cache' / 'recordings'
        for path in folder.glob('live_*.sqlite'):
            try:
                with reader(path) as conn:
                    meta = dict(conn.execute('SELECT key,value FROM metadata'))
                if json.loads(meta.get('saved','true')) or meta.get('temporary_format') != '1': continue
                owner = int(meta.get('owner_pid','0'))
                if owner:
                    try:
                        os.kill(owner, 0)
                        continue
                    except ProcessLookupError: pass
                for suffix in ('','-wal','-shm'): Path(str(path)+suffix).unlink(missing_ok=True)
            except (sqlite3.Error, OSError, ValueError):
                continue

    def create(self, config, root=None, port=None):
        if not isinstance(config, dict): raise ValueError('Expected a live configuration object')
        config = copy.deepcopy(config)
        config.setdefault('adapter', 'http'); config.setdefault('name', 'Live')
        config.setdefault('frame_id', 'world'); config.setdefault('cameras', [])
        if config['adapter'] not in ('http', 'ros1'): raise ValueError('Unknown live adapter')
        if not isinstance(config['frame_id'], str) or not config['frame_id'] or len(config['frame_id']) > 128:
            raise ValueError('Expected a nonempty world frame_id')
        if any(not isinstance(config.get(k, []), list) for k in ('tracks', 'cameras')):
            raise ValueError('Expected tracks and cameras arrays')
        if not 1 <= len(config.get('tracks', [])) <= 8 or not 0 <= len(config['cameras']) <= 4:
            raise ValueError('Expected 1-8 tracks and 0-4 image streams')
        ids = []
        for i, track in enumerate(config['tracks']):
            if not isinstance(track, dict): raise ValueError('Expected a track object')
            track.setdefault('id', f'method_{i}'); track.setdefault('name', track['id'])
            track.setdefault('color', '#71b4ff'); track.setdefault('truth', False)
            track.setdefault('type', 'nav_msgs/Odometry')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', track['id']): raise ValueError('Invalid track id')
            if not re.fullmatch(r'#[0-9a-fA-F]{6}', track['color']): raise ValueError('Invalid track color')
            if track['type'] not in POSE_TYPES: raise ValueError('Unsupported pose message type')
            ids.append(track['id'])
        if len(set(ids)) != len(ids): raise ValueError('Duplicate track ids')
        for i, camera in enumerate(config['cameras']):
            if not isinstance(camera, dict): raise ValueError('Expected a camera object')
            camera.setdefault('topic', f'camera_{i}'); camera.setdefault('type', 'sensor_msgs/Image')
            if camera['type'] not in IMAGE_TYPES: raise ValueError('Unsupported image message type')
            if camera.get('role', 'camera') not in ('camera', 'diagnostic'): raise ValueError('Unknown image role')
        for key, default, lo, hi in [('max_poses', 3000, 100, 20000), ('max_frames', 120, 1, 300),
                                     ('history_seconds', 120, 1, 600), ('max_pose_gap', .25, .01, 5)]:
            value = finite(config.setdefault(key, default))
            if not lo <= value <= hi: raise ValueError('Invalid '+key)
            config[key] = int(value) if key in ('max_poses', 'max_frames') else value
        if config['adapter'] == 'ros1':
            uri = urlparse(config.get('ros_master_uri', ''))
            if uri.scheme != 'http' or not uri.hostname or uri.username or uri.password:
                raise ValueError('Expected an HTTP ROS master URI')
            for channel in config['tracks']+config['cameras']:
                if not re.fullmatch(r'/[A-Za-z0-9_/]+', channel.get('topic', '')): raise ValueError('Invalid ROS topic')
        runner = config.get('runner')
        if runner is not None:
            if config['adapter'] != 'ros1' or not isinstance(runner, dict):
                raise ValueError('Process runner requires the ROS1 adapter')
            commands = runner.get('commands')
            bag = runner.get('bag')
            if not isinstance(commands, list) or not 1 <= len(commands) <= 8:
                raise ValueError('Runner needs 1-8 algorithm commands')
            if bag is not None:
                if not isinstance(bag, dict) or not Path(bag.get('path', '')).expanduser().is_file():
                    raise ValueError('Runner bag file does not exist')
                rate, start, duration = finite(bag.get('rate', 1)), finite(bag.get('start', 0)), finite(bag.get('duration', -1))
                if rate <= 0 or start < 0 or (duration != -1 and duration <= 0): raise ValueError('Invalid bag playback range/rate')
                bag['path'] = str(Path(bag['path']).expanduser().resolve())
                bag['rate'], bag['start'], bag['duration'] = rate, start, duration
                if not isinstance(bag.get('topics', []), list) or any(not re.fullmatch(r'/[A-Za-z0-9_/]+', t) for t in bag.get('topics', [])):
                    raise ValueError('Invalid rosbag topic list')
                if not isinstance(bag.get('loop', False), bool) or not isinstance(bag.get('clock', False), bool):
                    raise ValueError('bag loop and clock must be boolean')
            delay = finite(runner.get('startup_delay', 1))
            if not 0 <= delay <= 60: raise ValueError('Invalid startup_delay')
            runner['startup_delay'] = delay
            drain = finite(runner.get('drain_delay', 1))
            if not 0 <= drain <= 60: raise ValueError('Invalid drain_delay')
            runner['drain_delay'] = drain
            for i, command in enumerate(commands):
                if not isinstance(command, dict) or not isinstance(command.get('argv'), list) or not command['argv']:
                    raise ValueError('Each runner command needs a nonempty argv array')
                if any(not isinstance(arg, str) or not arg or '\0' in arg or len(arg) > 4096 for arg in command['argv']):
                    raise ValueError('Invalid runner argument')
                command.setdefault('id', f'algorithm_{i}')
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', command['id']): raise ValueError('Invalid runner command id')
                command.setdefault('setup', [])
                if not isinstance(command['setup'], list) or any(not Path(p).is_file() for p in command['setup']):
                    raise ValueError('ROS setup files must exist')
                if command.get('cwd') and not Path(command['cwd']).is_dir(): raise ValueError('Runner cwd must be a directory')
                if not isinstance(command.get('env', {}), dict) or any(not isinstance(k,str) or not re.fullmatch(r'[A-Z_][A-Z0-9_]*',k) or not isinstance(v,str) or '\0' in v for k,v in command.get('env',{}).items()):
                    raise ValueError('Invalid runner environment')
            if runner.get('auto_master', True):
                if urlparse(config['ros_master_uri']).hostname not in ('localhost', '127.0.0.1'):
                    raise ValueError('auto_master only supports localhost')
        with self.lock:
            if sum(not s.ended for s in self.sessions.values()) >= 4:
                raise ValueError('Stop an existing live session first')
            session = LiveSession(config, self.root)
            self.sessions[session.id] = session
            if config['adapter'] == 'ros1':
                try:
                    session.start_ros(root or self.root, port)
                except Exception:
                    del self.sessions[session.id]
                    session.close()
                    raise
            return session

    def recordings(self):
        folder = self.root / 'cache' / 'recordings'
        result = []
        if not folder.exists(): return result
        for path in sorted(folder.glob('live_*.sqlite'), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                with reader(path) as conn:
                    meta = dict(conn.execute('SELECT key,value FROM metadata'))
                    config, status = json.loads(meta['config']), json.loads(meta['status'])
                    if 'saved' in meta and not json.loads(meta['saved']):
                        continue
                    counts = json.loads(meta.get('counts', '{}'))
                    complete_track = conn.execute('SELECT 1 FROM poses LIMIT 1').fetchone() or conn.execute('SELECT 1 FROM frames LIMIT 1').fetchone()
                    if not complete_track:
                        has_debug = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='debug_samples'").fetchone()
                        if not has_debug or not conn.execute('SELECT 1 FROM debug_samples LIMIT 1').fetchone():
                            continue
                    result.append(dict(id=path.stem, name=config.get('name', path.stem), status=status,
                                       updated=path.stat().st_mtime, counts=counts, path=str(path)))
            except (sqlite3.Error, ValueError, KeyError):
                continue
        return result

    def delete_recording(self, recording_id):
        if not re.fullmatch(r'live_[0-9a-f]{32}', recording_id): raise ValueError('Invalid recording id')
        folder = (self.root / 'cache' / 'recordings').resolve()
        path = (folder / (recording_id + '.sqlite')).resolve()
        if path.parent != folder: raise ValueError('Invalid recording path')
        if not path.is_file(): raise ValueError('Recording not found')
        with self.lock:
            session = self.sessions.get(recording_id)
            if session and not session.ended: raise ValueError('Stop the live run before deleting its recording')
        if not session:
            with reader(path) as conn:
                status = json.loads(dict(conn.execute('SELECT key,value FROM metadata'))['status'])
            if status in ('starting', 'playing', 'attached'):
                raise ValueError('Stop the live run before deleting its recording')
        if session: session.close()
        with self.lock:
            self.sessions.pop(recording_id, None)
        for target in (path, Path(str(path)+'-wal'), Path(str(path)+'-shm')):
            target.unlink(missing_ok=True)
        return dict(id=recording_id, deleted=True)

    def load_recording(self, recording_id):
        if not re.fullmatch(r'live_[0-9a-f]{32}', recording_id): raise ValueError('Invalid recording id')
        path = self.root / 'cache' / 'recordings' / (recording_id + '.sqlite')
        if not path.is_file(): raise ValueError('Recording not found')
        with reader(path) as conn:
            meta = dict(conn.execute('SELECT key,value FROM metadata'))
            config, epoch = json.loads(meta['config']), json.loads(meta['epoch'])
            if epoch is None: epoch = 0
            tracks = []
            for spec in config['tracks']:
                rows = conn.execute('SELECT stamp,x,y,z,qx,qy,qz,qw FROM poses WHERE track=? ORDER BY stamp', (spec['id'],)).fetchall()
                # Empty pose tracks are valid while the estimator initializes.
                tracks.append(dict(id=spec['id'], name=spec.get('name',spec['id']), color=spec.get('color','#71b4ff'),
                                   truth=spec.get('truth',False), rmse=None, errors=[],
                                   poses=[[row[0]-epoch,*row[1:]] for row in rows]))
            cameras, sources = [], []
            for i, spec in enumerate(config['cameras']):
                rows = conn.execute('SELECT frame_id,stamp,width,height FROM frames WHERE camera=? ORDER BY stamp,frame_id', (i,)).fetchall()
                cameras.append(dict(topic=spec['topic'], role=spec.get('role','camera'), label=spec.get('label',spec['topic']),
                                    stamps=[r[1]-epoch for r in rows], frame_ids=[r[0] for r in rows],
                                    width=rows[0][2] if rows else 752, height=rows[0][3] if rows else 480, count=len(rows)))
                sources.append(dict(db=str(path), camera=i, offset=0))
            if not tracks: raise ValueError('Recording contains no complete pose track')
            debug = {kind: load_samples(conn, kind, epoch) for kind in ('diagnostics', 'markers')}
            end = max([s['stamp'] for values in debug.values() for s in values] + [t['poses'][-1][0] for t in tracks if t['poses']] + [c['stamps'][-1] for c in cameras if c['stamps']], default=0)
            project = dict(id=recording_id, name=config.get('name',recording_id)+' / 回放', adapter=config.get('adapter'),
                           alignment='none', frame_id=config.get('frame_id','world'), body_from_camera=config.get('body_from_camera'),
                           tracks=config['tracks'], cameras=config['cameras'], methods=[])
            data = dict(id=recording_id, project=project, epoch=epoch, duration=end,
                        start=0, **debug, recording_saved=json.loads(meta.get('saved','true')), cameras=cameras, tracks=tracks, max_gap=config.get('max_pose_gap',.25), archive=True)
            return dict(status=json.loads(meta['status']), data=data, project=project,
                        db=str(path), frame_sources=sources)

    def close(self):
        for session in list(self.sessions.values()): session.close()
