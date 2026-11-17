#!/usr/bin/python3
"""Local, read-only data adapters and deterministic export service for SLAM Studio."""
import argparse
import socket
import bisect
import concurrent.futures
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import signal
import shutil
import sqlite3
import subprocess
import threading
import time
import traceback
import xmlrpc.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import uuid

import cv2
import numpy as np
from scipy.spatial.transform import Rotation
from live import LiveHub
from data_sources import DataSources
from event_stream import serve as serve_events

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
DATA_ROOT = Path(os.environ.get('SLAM_STUDIO_DATA_ROOT', ROOT))
CACHE = DATA_ROOT / 'cache'
PROJECTS = DATA_ROOT / 'projects'
EXPORTS = DATA_ROOT / 'exports'
for directory in (CACHE, PROJECTS, EXPORTS):
    directory.mkdir(parents=True, exist_ok=True)
CONFIG_DIR = DATA_ROOT / 'config'
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
CONNECTION_PROFILES = CONFIG_DIR / 'connection_profiles.json'
SESSIONS, JOBS = {}, {}
LOCK = threading.RLock()
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1)
LIVE = LiveHub(root=DATA_ROOT)
SOURCES = DataSources(LIVE, SESSIONS)


def connection_profiles():
    if not CONNECTION_PROFILES.exists():
        return []
    try:
        values = json.loads(CONNECTION_PROFILES.read_text())
    except (OSError, ValueError) as error:
        raise ValueError('Cannot read local connection profiles: ' + str(error))
    if not isinstance(values, list):
        raise ValueError('Local connection profile file must contain a list')
    return values


def save_connection_profile(profile):
    if not isinstance(profile, dict) or not isinstance(profile.get('name'), str) or not profile['name'].strip():
        raise ValueError('Profile needs a name')
    config = profile.get('config')
    if not isinstance(config, dict):
        raise ValueError('Profile needs a connection config')
    values = connection_profiles()
    CONNECTION_PROFILES.parent.mkdir(parents=True, exist_ok=True)
    key = profile.get('id') or uuid.uuid4().hex
    item = dict(id=key, name=profile['name'].strip(), config=config)
    values = [v for v in values if v.get('id') != key]
    values.insert(0, item)
    tmp = CONNECTION_PROFILES.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(values, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(CONNECTION_PROFILES)
    return item


def ros_topics(master_uri):
    uri = urlparse(master_uri)
    if uri.scheme != 'http' or not uri.hostname or uri.username or uri.password:
        raise ValueError('Expected an HTTP ROS master URI')
    class TimeoutTransport(xmlrpc.client.Transport):
        def make_connection(self, host):
            connection = super().make_connection(host)
            connection.timeout = 2
            return connection
    try:
        status, message, topics = xmlrpc.client.ServerProxy(master_uri, transport=TimeoutTransport()).getPublishedTopics('/slam_studio', '')
    except Exception as error:
        raise ValueError('Cannot query ROS master: ' + str(error))
    if status != 1:
        raise ValueError(message or 'ROS master rejected topic query')
    return [dict(name=name, type=kind) for name, kind in topics]


def read_tum(spec):
    for key, choices, default in (
            ('quaternion_order', ('xyzw', 'wxyz'), 'xyzw'),
            ('quaternion_convention', ('hamilton', 'jpl'), 'hamilton'),
            ('orientation', ('sensor_to_world', 'world_to_sensor'), 'sensor_to_world')):
        if spec.get(key, default) not in choices:
            raise ValueError('Unknown '+key)
    data = np.loadtxt(Path(spec['path']).expanduser(), comments='#', ndmin=2)[:, :8]
    if len(data) < 2 or data.shape[1] != 8 or not np.isfinite(data).all():
        raise ValueError('Trajectory needs at least two finite TUM poses: ' + spec['path'])
    data[:, 0] = data[:, 0] * float(spec.get('timestamp_scale', 1)) + float(spec.get('time_offset', 0))
    data[:, 1:4] *= float(spec.get('position_scale', 1))
    data = data[np.argsort(data[:, 0], kind='stable')]
    data = data[np.r_[True, np.diff(data[:, 0]) > 0]]
    q = data[:, 4:8]
    if spec.get('quaternion_order', 'xyzw') == 'wxyz':
        q = q[:, [1, 2, 3, 0]]
    rot = Rotation.from_quat(q)
    if spec.get('quaternion_convention', 'hamilton') == 'jpl':
        rot = rot.inv()
    if spec.get('orientation', 'sensor_to_world') == 'world_to_sensor':
        rot = rot.inv()
    # T_sensor_body moves the output origin from the tracked sensor to the display body.
    extrinsic = np.asarray(spec.get('sensor_from_body', np.eye(4)), dtype=float)
    validate_transform(extrinsic)
    data[:, 1:4] += rot.apply(extrinsic[:3, 3])
    data[:, 4:8] = (rot * Rotation.from_matrix(extrinsic[:3, :3])).as_quat()
    if len(data) < 2:
        raise ValueError('Trajectory needs unique timestamps')
    return data


def validate_transform(matrix):
    if (matrix.shape != (4, 4) or not np.isfinite(matrix).all()
            or not np.allclose(matrix[3], [0, 0, 0, 1])
            or not np.allclose(matrix[:3, :3].T @ matrix[:3, :3], np.eye(3), atol=1e-5)
            or not np.isclose(np.linalg.det(matrix[:3, :3]), 1, atol=1e-5)):
        raise ValueError('Extrinsic must be a rigid 4x4 transform')


def transform_trajectory(data, matrix):
    validate_transform(matrix)
    out = data.copy()
    out[:, 1:4] = data[:, 1:4] @ matrix[:3, :3].T + matrix[:3, 3]
    out[:, 4:8] = (Rotation.from_matrix(matrix[:3, :3]) * Rotation.from_quat(data[:, 4:8])).as_quat()
    return out


def association(data, truth, max_gap):
    t = data[:, 0]
    ids = np.clip(np.searchsorted(truth[:, 0], t, side='right') - 1, 0, len(truth)-2)
    exact = (np.abs(t-truth[ids, 0]) < 1e-5) | (np.abs(t-truth[ids+1, 0]) < 1e-5)
    valid = ((t >= truth[0, 0]) & (t <= truth[-1, 0])
             & ((truth[ids+1, 0]-truth[ids, 0] <= max_gap) | exact))
    xyz = np.column_stack([np.interp(t, truth[:, 0], truth[:, k]) for k in (1, 2, 3)])
    return valid, xyz


def align_trajectory(data, truth, alignment, max_gap=.25):
    valid, xyz = association(data, truth, max_gap)
    out = data.copy()
    matrix = np.eye(4)
    if alignment == 'se3':
        if valid.sum() < 3:
            raise ValueError('SE(3) alignment requires at least three matched positions')
        a, b = data[valid, 1:4], xyz[valid]
        ac, bc = a.mean(0), b.mean(0)
        u, singular, vt = np.linalg.svd((a-ac).T @ (b-bc))
        if singular[1] < 1e-10:
            raise ValueError('SE(3) alignment is unobservable for this trajectory')
        correction = np.diag([1, 1, np.linalg.det(vt.T @ u.T)])
        rot = vt.T @ correction @ u.T
        trans = bc - rot @ ac
        out[:, 1:4] = data[:, 1:4] @ rot.T + trans
        out[:, 4:8] = (Rotation.from_matrix(rot) * Rotation.from_quat(data[:, 4:8])).as_quat()
        matrix[:3, :3], matrix[:3, 3] = rot, trans
    errors = np.linalg.norm(out[:, 1:4]-xyz, axis=1)
    return out, {'matrix': matrix.tolist(), 'matched': int(valid.sum()),
                 'rmse': float(np.sqrt(np.mean(errors[valid]**2))) if valid.any() else None,
                 'errors': [[float(t), float(e)] for t, e in zip(data[valid, 0], errors[valid])]}


def seed_projects():
    base = WORKSPACE / 'imu_guided_outlier_filter_ws/src/open_vins/results/viode_final/2026-10-26'
    entries = []
    for scene in ('city_night', 'city_day', 'parking_lot'):
        for level in ('3_high', '2_mid', '1_low', '0_none'):
            seq = level if scene == 'parking_lot' else scene+'/'+level
            folder = seq.replace('/', '_')
            bag = WORKSPACE / 'datasets/viode' / (seq+'.bag')
            if not bag.exists():
                continue
            project = {'id': scene+'_'+level, 'name': scene.replace('_', ' ').title()+' / '+level,
                       'dataset': 'VIODE', 'alignment': 'se3', 'max_pose_gap': .25,
                       'display_world_from_world': [[1,0,0,0],[0,-1,0,0],[0,0,-1,0],[0,0,0,1]],
                       'bag': str(bag), 'image_topics': ['/cam0/image_raw', '/cam1/image_raw'],
                       'image_time_offset': 0,
                       'body_from_camera': [[0,0,1,0],[1,0,0,0],[0,1,0,0],[0,0,0,1]],
                       'body_from_cameras': [
                           [[0,0,1,0],[1,0,0,0],[0,1,0,0],[0,0,0,1]],
                           [[0,0,1,0],[1,0,0,.05],[0,1,0,0],[0,0,0,1]]],
                       'camera_intrinsics': [dict(width=752,height=480,fx=376,fy=376,cx=376,cy=240) for _ in range(2)],
                       'truth': {'path': str(base/'imu_guided/run_001'/folder/'groundtruth_tum.txt')},
                       'methods': []}
            for name, color, path, note in (
                ('IMU-guided', '#c7ef79', base/'imu_guided/run_001'/folder/'estimated_tum.txt', '2026-10-26'),
                ('RANSAC', '#71b4ff', base/'ransac/run_001'/folder/'estimated_tum.txt', '2026-10-26'),
                ('DynaVINS', '#fa9179', base/'dynavins_historical'/folder/'vio.csv', 'Historical')):
                if path.exists():
                    project['methods'].append({'name': name, 'color': color, 'path': str(path), 'note': note})
            fusion = WORKSPACE / 'vins_fusion_results/viode/run_001/viode_viode_stereo_imu_original_config' / folder
            fusion_name = 'VINS-Fusion (modified)'
            fusion_note = 'Modified workspace binary; motion and backend filters disabled; NOT a pristine upstream baseline; run_001'
            if not (fusion/'estimated_tum.txt').exists():
                fusion = WORKSPACE / 'evo_results_catkin_ws_original_after_port/viode_viode_stereo_imu_original_config' / folder
                fusion_name = 'VINS-Fusion (historical)'
                fusion_note = 'Historical workspace result; MotionOutlierFilter disabled; upstream provenance not verified'
            if (fusion/'estimated_tum.txt').exists():
                project['methods'].append({
                    'name': fusion_name, 'color': '#e6b95c',
                    'path': str(fusion/'estimated_tum.txt'),
                    'note': fusion_note,
                    'source_log': str(fusion/'vins_node.log')})
            entries.append(project)
    return entries


def comparison_projects():
    base = WORKSPACE / 'imu_guided_outlier_filter_ws/src/open_vins/results/viode_num_pts_400'
    original = WORKSPACE / 'openvins_results/original/num_pts_200_400/pts_400'
    fusion = WORKSPACE / 'vins_fusion_results/viode/original_200_15_run_001/viode_viode_stereo_imu/3_high/estimated_tum.txt'
    entries = []
    for project in seed_projects():
        sequence = Path(project['bag']).relative_to(WORKSPACE / 'datasets/viode').with_suffix('').as_posix()
        folder = sequence.replace('/', '_')
        truth = base / 'imu_guided_all/run_001' / folder / 'groundtruth_tum.txt'
        if not truth.is_file():
            continue
        project['id'] = 'comparison_400_200_' + project['id']
        project['name'] += ' [400 / 200]'
        project['truth'] = {'path': str(truth)}
        project['methods'] = []
        candidates = [
            ('IMU-guided 400', '#c7ef79', base/'imu_guided_all/run_001'/folder/'estimated_tum.txt',
             'num_pts=400, 10 px spacing; RANSAC only during initialization; full-12 run_001'),
            ('OpenVINS original 400', '#71b4ff', original/('run_002' if sequence == '3_high' else 'run_003')/folder/'estimated_tum.txt',
             'Unmodified original source 69488123; num_pts=400, 10 px spacing; common evaluation config, not stock defaults. '
             'Saved trajectory verified; process exit 134 during image-transport teardown.'),
            ('DynaVINS 200', '#fa9179', base/'dynavins_200_15/run_001'/folder/'vio.csv',
             'max_cnt=200, 15 px spacing, weights 1.0/0.2; full-12 run_001. '
             'Playback complete; exit -6 on requested shutdown.')]
        if sequence == '3_high':
            candidates.append(('VINS-Fusion original 200', '#e6b95c', fusion,
                               'Clean OpenCV4-compatible original source 8b70679e; max_cnt=200, 15 px spacing; original_200_15_run_001'))
        for name, color, path, note in candidates:
            if path.is_file():
                project['methods'].append(dict(name=name, color=color, path=str(path), note=note))
        project['view'] = dict(camera='orbit', pathMode='full', selectedTrack='method_0')
        entries.append(project)
    return entries


def projects():
    result = {}
    for path in PROJECTS.glob('*.json'):
        try:
            p = json.loads(path.read_text()); result[p['id']] = p
        except (ValueError, KeyError):
            continue
    return list(result.values())


def bag_files(directory):
    folder = Path(directory).expanduser().resolve()
    if not folder.is_dir(): raise ValueError('Bag directory not found')
    files = sorted((p for p in folder.iterdir() if p.is_file() and p.suffix.lower()=='.bag'), key=lambda p:p.name.lower())
    return dict(directory=str(folder), files=[dict(name=p.name, path=str(p), size=p.stat().st_size) for p in files])


def image_array(msg):
    if getattr(msg, '_type', '') == 'sensor_msgs/CompressedImage':
        img = cv2.imdecode(np.frombuffer(msg.data, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError('Invalid compressed image')
        return img
    encoding = msg.encoding.lower()
    channels = {'rgb8': 3, 'bgr8': 3, 'mono8': 1, '8uc1': 1, 'rgba8': 4, 'bgra8': 4}.get(encoding)
    if channels is None:
        raise ValueError('Unsupported image encoding: ' + encoding)
    a = np.frombuffer(msg.data, np.uint8).reshape(msg.height, msg.step)
    a = a[:, :msg.width * channels].reshape(msg.height, msg.width, channels)
    if encoding == 'rgb8': a = cv2.cvtColor(a, cv2.COLOR_RGB2BGR)
    if encoding == 'rgba8': a = cv2.cvtColor(a, cv2.COLOR_RGBA2BGR)
    if encoding == 'bgra8': a = cv2.cvtColor(a, cv2.COLOR_BGRA2BGR)
    return a


def prepare_bag(project, session):
    import rosbag
    path = Path(project['bag']).expanduser().resolve()
    stat = path.stat()
    key = hashlib.sha256(json.dumps([str(path), stat.st_size, stat.st_mtime_ns, project['image_topics'], 2]).encode()).hexdigest()[:24]
    db_path = CACHE / (key+'.sqlite')
    if not db_path.exists():
        tmp = CACHE / (key+'.building')
        if tmp.exists(): tmp.unlink()
        with sqlite3.connect(tmp) as conn, rosbag.Bag(str(path)) as bag:
            topics = project['image_topics']
            infos = bag.get_type_and_topic_info().topics
            for topic in topics:
                if topic not in infos:
                    raise ValueError('Image topic not found: '+topic)
            total = sum(infos[t].message_count for t in topics)
            conn.execute('CREATE TABLE frames(camera INTEGER, stamp REAL, jpeg BLOB)')
            for n, (topic, msg, _) in enumerate(bag.read_messages(topics=topics)):
                ok, jpg = cv2.imencode('.jpg', image_array(msg), [cv2.IMWRITE_JPEG_QUALITY, 90])
                if not ok: raise ValueError('Image encoding failed')
                conn.execute('INSERT INTO frames VALUES (?,?,?)', (topics.index(topic), msg.header.stamp.to_sec(), jpg.tobytes()))
                if n % 30 == 0:
                    session['progress'] = round((n+1)/total, 3)
            conn.execute('CREATE INDEX frame_time ON frames(camera, stamp)')
        tmp.replace(db_path)
    cameras = []
    with sqlite3.connect(db_path) as conn:
        for camera, topic in enumerate(project['image_topics']):
            stamps = [r[0] + float(project.get('image_time_offset', 0)) for r in conn.execute(
                'SELECT stamp FROM frames WHERE camera=? ORDER BY stamp', (camera,))]
            if not stamps: raise ValueError('Empty image topic: '+topic)
            jpeg = conn.execute('SELECT jpeg FROM frames WHERE camera=? LIMIT 1', (camera,)).fetchone()[0]
            height, width = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE).shape
            cameras.append({'topic': topic, 'stamps': stamps, 'count': len(stamps), 'width': width, 'height': height})
    return db_path, cameras


def prepare_session(project, session):
    try:
        session.update(status='indexing', progress=0)
        db, cameras = prepare_bag(project, session) if project.get('bag') else (None, [])
        for i, extrinsic in enumerate(project.get('body_from_cameras', [])):
            if i >= len(cameras): raise ValueError('Too many camera extrinsics')
            validate_transform(np.asarray(extrinsic, dtype=float))
        for i, intrinsic in enumerate(project.get('camera_intrinsics', [])):
            values = [intrinsic[k] for k in ('width','height','fx','fy','cx','cy')]
            if (i >= len(cameras) or not np.isfinite(values).all() or min(values[:4]) <= 0
                    or intrinsic['width'] != cameras[i]['width'] or intrinsic['height'] != cameras[i]['height']):
                raise ValueError('Camera intrinsics must match the image size and have positive focal lengths')
        raw_tracks = [read_tum(spec) for spec in project['methods']]
        if project.get('truth'): raw_tracks.append(read_tum(project['truth']))
        base = min(c['stamps'][0] for c in cameras) if cameras else min(t[0,0] for t in raw_tracks)
        end = max(c['stamps'][-1] for c in cameras) if cameras else max(t[-1,0] for t in raw_tracks)
        sources = [dict(db=str(db), camera=i, offset=float(project.get('image_time_offset', 0))) for i in range(len(cameras))]
        for spec in project.get('diagnostic_images', []):
            offset = float(spec.get('time_offset', 0))
            if not np.isfinite(offset): raise ValueError('Diagnostic image offset must be finite')
            diagnostic_db, streams = prepare_bag(dict(bag=spec['bag'], image_topics=[spec['topic']], image_time_offset=offset), session)
            camera = streams[0]
            if camera['stamps'][-1] < base or camera['stamps'][0] > end:
                raise ValueError('Diagnostic images do not overlap the recording: '+spec['topic'])
            camera.update(role='diagnostic', label=spec.get('label', spec['topic']))
            cameras.append(camera)
            sources.append(dict(db=str(diagnostic_db), camera=0, offset=offset))
        clip = project.get('clip', [0, end-base])
        if len(clip) != 2 or not 0 <= clip[0] < clip[1] <= end-base+.001:
            raise ValueError('Clip must lie within the image recording interval')
        truth = read_tum(project['truth']) if project.get('truth') else None
        tracks = []
        if truth is not None:
            tracks.append({'id': 'truth', 'name': 'Ground truth', 'color': '#becac5', 'truth': True,
                           'poses': truth.tolist(), 'rmse': None, 'errors': []})
        for i, spec in enumerate(project['methods']):
            data = read_tum(spec)
            if truth is not None:
                data, stats = align_trajectory(data, truth, project.get('alignment', 'none'), project.get('max_pose_gap', .25))
            else:
                stats = {'rmse': None, 'errors': [], 'matrix': np.eye(4).tolist(), 'matched': 0}
            tracks.append(dict(stats, id='method_'+str(i), name=spec['name'], color=spec.get('color', '#71b4ff'),
                               note=spec.get('note', ''), poses=data.tolist(), truth=False))
        for track in tracks:
            # Keep only the sensor recording interval, preserving one boundary sample for interpolation.
            a = np.asarray(track['poses'])
            lo = max(0, int(np.searchsorted(a[:,0], base))-1)
            hi = min(len(a), int(np.searchsorted(a[:,0], end, side='right'))+1)
            a = a[lo:hi]
            if len(a)<2: raise ValueError('No trajectory overlap: '+track['name'])
            a = transform_trajectory(a, np.asarray(project.get('display_world_from_world', np.eye(4)), dtype=float))
            a[:,0] -= base
            track['poses'] = a.tolist()
            track['errors'] = [[t-base,e] for t,e in track['errors'] if base<=t<=end]
        for camera in cameras:
            camera['stamps'] = [t-base for t in camera['stamps']]
        validate_transform(np.asarray(project.get('body_from_camera', np.eye(4)), dtype=float))
        session.update(status='ready', progress=1, db=str(db), frame_sources=sources, data={
            'id': session['id'], 'project': project, 'epoch': base, 'duration': end-base,
            'cameras': cameras, 'tracks': tracks, 'max_gap': project.get('max_pose_gap', .25)})
    except Exception as error:
        traceback.print_exc()
        session.update(status='error', error=str(error))


def launch_session(project):
    if not isinstance(project, dict):
        raise ValueError('Project must be a JSON object')
    if not project.get('methods') or (project.get('bag') and not 1 <= len(project.get('image_topics', [])) <= 2):
        raise ValueError('At least one trajectory and one or two image topics are required')
    if not isinstance(project.get('diagnostic_images', []), list) or len(project.get('diagnostic_images', [])) > 4:
        raise ValueError('At most four diagnostic image streams are supported')
    if project.get('alignment', 'none') not in ('none', 'se3'):
        raise ValueError('Only raw or SE(3) alignment is supported; no scale fitting')
    if not 0 < float(project.get('max_pose_gap', .25)) < float('inf'):
        raise ValueError('max_pose_gap must be finite and positive')
    sid = uuid.uuid4().hex
    session = {'id': sid, 'status': 'queued', 'project': project}
    with LOCK: SESSIONS[sid] = session
    POOL.submit(prepare_session, project, session)
    return {'id': sid}


def export_worker(job, url):
    proc = None
    try:
        node = ROOT / '.tools/node-v22.15.0-linux-x64/bin/node'
        command = [str(node) if node.exists() else 'node', str(ROOT/'tools/render.mjs'), job['config'], url]
        with open(EXPORTS/(job['id']+'.log'), 'w') as log:
            with LOCK:
                if job['status'] == 'cancelled': return
                proc = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=log,
                                        text=True, start_new_session=True)
                job['pid'] = proc.pid
            for line in proc.stdout:
                try:
                    message = json.loads(line)
                    if job['status'] != 'cancelled': job.update(message)
                except ValueError:
                    log.write(line)
            code = proc.wait()
        if job['status'] == 'cancelled': return
        if code != 0: raise RuntimeError('Render failed. '+(EXPORTS/(job['id']+'.log')).read_text()[-1500:])
        job.update(status='done', progress=1)
    except Exception as error:
        if job['status'] != 'cancelled': job.update(status='error', error=str(error))


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def log_message(self, fmt, *args):
        if not args or ('/frame?' not in str(args[0]) and '/samples' not in str(args[0])): super().log_message(fmt, *args)

    def send(self, data, code=200, mime='application/json'):
        payload = json.dumps(data, allow_nan=False).encode() if mime=='application/json' else data
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store' if mime in ('application/json','text/html') else 'private, max-age=3600')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        try: self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError): pass

    def do_GET(self):
        try:
            url = urlparse(self.path); path = url.path; query = parse_qs(url.query)
            if path.startswith('/api/data/'):
                parts = path.split('/'); key = parts[3]
                action = parts[4] if len(parts)>4 else 'info'
                if action == 'frame':
                    return self.send(SOURCES.frame(key, int(query['camera'][0]), int(query['index'][0])), mime='image/jpeg')
                if action == 'window':
                    return self.send(SOURCES.window(key, float(query.get('start',['0'])[0]), float(query.get('end',['inf'])[0])))
                return self.send(SOURCES.info(key, history=query.get('history',['0'])[0]=='1'))
            if path == '/api/projects': return self.send(projects())
            if path == '/api/connection-profiles': return self.send(connection_profiles())
            if path == '/api/ros/topics': return self.send(ros_topics(query.get('master', [''])[0]))
            if path == '/api/bags': return self.send(bag_files(query.get('directory', [str(Path.home())])[0]))
            if path == '/api/recordings': return self.send(LIVE.recordings())
            if path == '/api/live': return self.send([dict(id=s.id,name=s.config['name'],status=s.snapshot_status(),saved=s.recording_saved) for s in LIVE.sessions.values()])
            if path.startswith('/api/recordings/'):
                recording_id = path.split('/')[-1]
                archive = LIVE.load_recording(recording_id)
                with LOCK:
                    SESSIONS[recording_id] = dict(id=recording_id, status='ready', project=archive['project'],
                                                   data=archive['data'], db=archive['db'],
                                                   frame_sources=archive['frame_sources'])
                return self.send(archive['data'])
            if path.startswith('/api/live/'):
                parts = path.split('/'); session = LIVE.sessions[parts[3]]
                if len(parts)==5 and parts[4]=='events':
                    token = self.headers.get('Last-Event-ID') or query.get('cursor',['-1:-1'])[0]
                    generation, cursor = map(int, token.split(':'))
                    return serve_events(self, session, cursor, generation)
                if len(parts)==5 and parts[4]=='frame':
                    return self.send(session.frame(int(query['camera'][0]), int(query['index'][0])), mime='image/jpeg')
                if len(parts)==5 and parts[4]=='frame_at':
                    return self.send(session.frame_at(int(query['camera'][0]), float(query['time'][0])), mime='image/jpeg')
                return self.send(session.snapshot())
            if path.startswith('/api/session/'):
                session = SESSIONS[path.split('/')[-1]]
                return self.send({k:v for k,v in session.items() if k not in ('db', 'project', 'frame_sources')})
            if path == '/api/frame':
                s = SESSIONS[query['session'][0]]
                camera = int(query.get('camera', ['0'])[0]); index = int(query['index'][0])
                if not 0 <= camera < len(s['data']['cameras']): raise ValueError('Invalid camera')
                stamps = s['data']['cameras'][camera]['stamps']
                if not 0 <= index < len(stamps): raise ValueError('Frame index out of bounds')
                source = s['frame_sources'][camera]
                stamp = stamps[index]+s['data']['epoch']-source['offset']
                with sqlite3.connect(source['db']) as conn:
                    row = conn.execute('SELECT jpeg FROM frames WHERE camera=? AND stamp BETWEEN ? AND ? ORDER BY ABS(stamp-?) LIMIT 1',
                                       (source['camera'], stamp-1e-4, stamp+1e-4, stamp)).fetchone()
                if row is None: raise ValueError('Frame unavailable')
                return self.send(row[0], mime='image/jpeg')
            if path.startswith('/api/export/'):
                parts = path.split('/'); job = JOBS[parts[3]]
                if len(parts)==5 and parts[4]=='file':
                    if job['status'] != 'done': raise ValueError('Export not ready')
                    with open(job['output'], 'rb') as stream:
                        self.send_response(200)
                        self.send_header('Content-Type', 'image/png' if job['kind']=='snapshot' else 'video/mp4')
                        self.send_header('Content-Length', str(os.fstat(stream.fileno()).st_size))
                        self.end_headers()
                        try: shutil.copyfileobj(stream, self.wfile)
                        except (BrokenPipeError, ConnectionResetError): pass
                    return
                return self.send({k:v for k,v in job.items() if k not in ('pid','config')})
            relative = path.lstrip('/') or 'index.html'
            file = (ROOT/'dist'/relative).resolve()
            if (ROOT/'dist').resolve() not in file.parents: return self.send({'error':'Not found'},404)
            if not file.is_file(): return self.send({'error':'Not found'},404)
            return self.send(file.read_bytes(), mime=mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        except (ValueError, TypeError, KeyError, IndexError, OSError) as error:
            self.send({'error':str(error)},400)

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if origin and urlparse(origin).netloc != self.headers.get('Host'):
                return self.send({'error':'Cross-origin writes are disabled'},403)
            length = int(self.headers.get('Content-Length', 0))
            if length > (8_000_000 if self.path.endswith('/samples') else 2_000_000): raise ValueError('Request too large')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict): raise ValueError('Request must be a JSON object')
            path = urlparse(self.path).path
            if path.startswith('/api/data/') and path.endswith('/release'):
                return self.send(SOURCES.release(path.split('/')[3]))
            if path == '/api/live':
                validate_transform(np.asarray(data.get('body_from_camera', np.eye(4)), dtype=float))
                return self.send(LIVE.create(data, ROOT, self.server.server_port).snapshot())
            if path == '/api/connection-profiles':
                return self.send(save_connection_profile(data))
            if path.startswith('/api/live/'):
                parts = path.split('/'); session = LIVE.sessions[parts[3]]
                if parts[4] == 'samples':
                    session.push(data); return self.send({'revision':session.revision})
                if parts[4] == 'stop': session.stop()
                elif parts[4] == 'reset': session.reset()
                elif parts[4] == 'save': return self.send(session.save_recording())
                elif parts[4] == 'discard':
                    session.stop()
                    return self.send(LIVE.delete_recording(session.id))
                else: raise ValueError('Unknown live command')
                return self.send(session.snapshot())
            if path == '/api/load': return self.send(launch_session(data))
            if path == '/api/projects':
                data['id'] = 'saved_'+uuid.uuid4().hex[:12]
                (PROJECTS/(data['id']+'.json')).write_text(json.dumps(data, indent=2))
                return self.send(data)
            if path == '/api/export':
                with LOCK:
                    if any(j['status'] in ('starting','rendering') for j in JOBS.values()):
                        raise ValueError('An export is already running')
                    s = SESSIONS[data['session']]
                    if s['status'] != 'ready': raise ValueError('Session not ready')
                    start, end = float(data['start']), float(data['end'])
                    fps, height = int(data.get('fps',30)), int(data.get('height',1080))
                    if not (0<=start<end<=s['data']['duration']+.001 and fps in (24,30,60) and height in (720,1080,2160)):
                        raise ValueError('Invalid export range, frame rate, or resolution')
                    kind = data.get('kind','video')
                    if kind not in ('video','snapshot'): raise ValueError('Unknown export kind')
                    jid = uuid.uuid4().hex
                    output = EXPORTS/(jid+('.png' if kind=='snapshot' else '.mp4'))
                    config = dict(data, id=jid, output=str(output), fps=fps, height=height)
                    config_path = EXPORTS/(jid+'.json'); config_path.write_text(json.dumps(config))
                    job = {'id':jid, 'status':'starting', 'progress':0, 'kind':kind,
                           'output':str(output), 'config':str(config_path)}
                    JOBS[jid] = job
                    url = 'http://127.0.0.1:'+str(self.server.server_port)
                    threading.Thread(target=export_worker, args=(job,url), daemon=True).start()
                return self.send(job)
            if path.endswith('/cancel'):
                job = JOBS[path.split('/')[-2]]
                with LOCK:
                    if job['status'] in ('starting','rendering'):
                        job['status']='cancelled'
                        if job.get('pid'):
                            try: os.killpg(job['pid'],signal.SIGTERM)
                            except ProcessLookupError: pass
                return self.send({'status':job['status']})
            return self.send({'error':'Not found'},404)
        except (ValueError, TypeError, KeyError, IndexError, OSError) as error:
            self.send({'error':str(error)},400)

    def do_DELETE(self):
        try:
            origin = self.headers.get('Origin')
            if origin and urlparse(origin).netloc != self.headers.get('Host'):
                return self.send({'error':'Cross-origin writes are disabled'},403)
            path = urlparse(self.path).path
            if path.startswith('/api/connection-profiles/'):
                key = path.split('/')[-1]
                values = [v for v in connection_profiles() if v.get('id') != key]
                if len(values) == len(connection_profiles()):
                    raise ValueError('Connection profile not found')
                tmp = CONNECTION_PROFILES.with_suffix('.json.tmp')
                tmp.write_text(json.dumps(values, ensure_ascii=False, indent=2) + '\n')
                tmp.replace(CONNECTION_PROFILES)
                return self.send({'id': key, 'deleted': True})
            if path.startswith('/api/recordings/'):
                return self.send(LIVE.delete_recording(path.split('/')[-1]))
            return self.send({'error':'Not found'},404)
        except (ValueError, TypeError, KeyError, IndexError, OSError) as error:
            self.send({'error':str(error)},400)


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    LIVE.cleanup_temporary()
    ThreadingHTTPServer.request_queue_size = 128
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'SLAM Studio: http://127.0.0.1:{args.port}',flush=True)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        LIVE.close()
        server.server_close()
