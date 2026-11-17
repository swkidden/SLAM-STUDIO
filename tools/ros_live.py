#!/usr/bin/python3
"""ROS1 subscriber -> generic SLAM Studio live samples. No estimator control."""
import base64
from collections import deque
import json
from pathlib import Path
import sys
import signal
import threading
import time
import urllib.request
import urllib.error
import xmlrpc.client

import cv2
import rospy
import roslib.message

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import image_array


class TimeoutTransport(xmlrpc.client.Transport):
    def make_connection(self, host):
        connection = super().make_connection(host); connection.timeout = 4
        return connection


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    master = xmlrpc.client.ServerProxy(config['ros_master_uri'], transport=TimeoutTransport())
    master.getUri('/slam_studio_probe')
    rospy.init_node('slam_studio_bridge', anonymous=True, disable_signals=True)
    signal.signal(signal.SIGTERM, lambda *_: rospy.signal_shutdown('receiver stopped'))
    counts = dict(source_poses=0,source_frames=0,bridge_dropped_poses=0,bridge_dropped_frames=0)
    pending_debug = {"diagnostics": deque(maxlen=1000), "markers": deque(maxlen=1000)}
    pending_poses, pending_images, lock = [], [deque(maxlen=100) for _ in config['cameras']], threading.Lock()

    def pose(message, spec):
        if spec['type'] == 'nav_msgs/Path':
            if not message.poses: return
            message = message.poses[-1]
        if message.header.frame_id != config['frame_id']:
            rospy.logwarn_throttle(5, 'Frame mismatch on %s: got %s, expected %s', spec['topic'], message.header.frame_id, config['frame_id'])
            return
        value = message.transform if spec['type'] == 'geometry_msgs/TransformStamped' else message.pose
        if hasattr(value, 'pose'): value = value.pose
        p = value.translation if hasattr(value, 'translation') else value.position
        q = value.rotation if hasattr(value, 'rotation') else value.orientation
        sample = dict(track=spec['id'], stamp=message.header.stamp.to_sec(), frame_id=message.header.frame_id,
                      position=[p.x,p.y,p.z], orientation=[q.x,q.y,q.z,q.w])
        with lock:
            counts['source_poses'] += 1
            pending_poses.append(sample)
            if len(pending_poses)>2000:
                counts['bridge_dropped_poses'] += len(pending_poses)-2000
                del pending_poses[:len(pending_poses)-2000]

    def image(message, index):
        with lock:
            counts['source_frames'] += 1
            if len(pending_images[index]) == pending_images[index].maxlen: counts['bridge_dropped_frames'] += 1
            pending_images[index].append(message)

    def scalar(text):
        try:
            value = json.loads(text)
            return value if value is None or isinstance(value, (bool, int, float, str)) else text
        except (ValueError, TypeError):
            return text

    def diagnostic(message, topic):
        stamp = message.header.stamp.to_sec()
        if stamp == 0: stamp = rospy.Time.now().to_sec()
        samples = [dict(schema_version=1, source=topic, name=status.name, stamp=stamp,
                        level=int(status.level), message=status.message,
                        values={item.key: scalar(item.value) for item in status.values}) for status in message.status]
        with lock: pending_debug['diagnostics'].extend(samples)

    def markers(message, topic):
        samples = []
        for marker in message.markers:
            if marker.action not in (0, 2, 3): continue
            if marker.action == 0 and marker.type not in (0, 2): continue
            action = {0:'add', 2:'delete', 3:'clear'}[marker.action]
            stamp = marker.header.stamp.to_sec() or rospy.Time.now().to_sec()
            q, point, scale, color = marker.pose.orientation, marker.pose.position, marker.scale, marker.color
            samples.append(dict(schema_version=1, source=topic, name=marker.ns or 'markers', id=marker.id,
                stamp=stamp, frame_id=marker.header.frame_id, action=action,
                type='ellipsoid' if marker.type == 2 else 'arrow',
                position=[point.x,point.y,point.z], orientation=[q.x,q.y,q.z,q.w],
                scale=[scale.x,scale.y,scale.z], color=[color.r,color.g,color.b,color.a],
                points=[[p.x,p.y,p.z] for p in marker.points], lifetime=marker.lifetime.to_sec()))
        with lock: pending_debug['markers'].extend(samples)

    subscribers = [rospy.Subscriber(s['topic'], roslib.message.get_message_class(s['type']), pose, s, queue_size=100)
                   for s in config['tracks']]
    subscribers += [rospy.Subscriber(s['topic'], roslib.message.get_message_class(s['type']), image, i, queue_size=100, buff_size=32*1024*1024)
                    for i,s in enumerate(config['cameras'])]
    from diagnostic_msgs.msg import DiagnosticArray
    debug_subscribers = {'/diagnostics': rospy.Subscriber('/diagnostics', DiagnosticArray, diagnostic, '/diagnostics', queue_size=1000)}
    discovered_at = 0
    while not rospy.is_shutdown():
        if time.monotonic()-discovered_at > 2:
            discovered_at = time.monotonic()
            for topic, kind in rospy.get_published_topics():
                if topic in debug_subscribers: continue
                callback = diagnostic if kind == 'diagnostic_msgs/DiagnosticArray' else markers if kind == 'visualization_msgs/MarkerArray' else None
                if callback:
                    debug_subscribers[topic] = rospy.Subscriber(topic, roslib.message.get_message_class(kind), callback, topic, queue_size=100)

        with lock:
            debug = {key: list(queue) for key,queue in pending_debug.items()}
            for queue in pending_debug.values(): queue.clear()
            stats = dict(counts)
            poses = pending_poses[:]; pending_poses.clear()
            images = []
            while len(images) < 4 and any(pending_images):
                for index, queue in enumerate(pending_images):
                    if queue and len(images) < 4: images.append((index, queue.popleft()))
        frames = []
        for index, message in images:
            array = image_array(message)
            if array.shape[1] > 960:
                array = cv2.resize(array, (960, round(array.shape[0]*960/array.shape[1])))
            ok, jpg = cv2.imencode('.jpg', array, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok: frames.append(dict(camera=index, stamp=message.header.stamp.to_sec(), jpeg=base64.b64encode(jpg).decode()))
        if poses or frames or any(debug.values()):
            payload = json.dumps(dict(poses=poses, frames=frames, transport_counts=stats, **debug)).encode()
            request = urllib.request.Request(config['endpoint']+'/api/live/'+config['session']+'/samples', payload,
                                             {'Content-Type':'application/json'})
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=4) as response: response.read()
            except urllib.error.HTTPError as error:
                raise RuntimeError(error.read().decode()) from error
            except (urllib.error.URLError, TimeoutError) as error:
                rospy.logwarn_throttle(5, 'Live upload unavailable: %s', error)
        else:
            time.sleep(.01)
    for subscriber in [*subscribers, *debug_subscribers.values()]: subscriber.unregister()


if __name__ == '__main__':
    main()
