#!/usr/bin/python3
"""Record an algorithm's rendered image topic without redrawing its annotations."""
import argparse
import json
from pathlib import Path
import signal
import threading

import cv2
import numpy as np
import rosbag
import rospy
from sensor_msgs.msg import CompressedImage, Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    parser.add_argument('--topic', default='/ros1_serial_msckf/trackhist')
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    rospy.init_node('studio_visualization_recorder', anonymous=True, disable_signals=True)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    lock = threading.Lock()
    stamps, errors = [], []
    with rosbag.Bag(str(args.output), 'w') as bag:
        def receive(msg):
            try:
                if msg.encoding != 'bgr8':
                    raise ValueError('Expected algorithm BGR8 image')
                array = np.frombuffer(msg.data, np.uint8).reshape(msg.height, msg.step)
                array = array[:, :msg.width*3].reshape(msg.height, msg.width, 3)
                ok, jpg = cv2.imencode('.jpg', array, [cv2.IMWRITE_JPEG_QUALITY, 95])
                if not ok:
                    raise ValueError('JPEG encoding failed')
                out = CompressedImage(header=msg.header, format='jpeg', data=jpg.tobytes())
                with lock:
                    bag.write(args.topic+'/compressed', out, t=msg.header.stamp)
                    stamps.append(msg.header.stamp.to_sec())
            except Exception as error:
                errors.append(str(error))
        subscriber = rospy.Subscriber(args.topic, Image, receive, queue_size=200, buff_size=32*1024*1024)
        args.output.with_suffix('.ready').touch()
        stop.wait()
        subscriber.unregister()
        with lock:
            rospy.signal_shutdown('Recording complete')
    args.output.with_suffix('.json').write_text(json.dumps(dict(
        source_topic=args.topic, recorded_topic=args.topic+'/compressed', count=len(stamps),
        first_stamp=stamps[0] if stamps else None, last_stamp=stamps[-1] if stamps else None,
        max_gap=max(np.diff(stamps), default=0), errors=errors), indent=2))
    if errors or not stamps:
        raise RuntimeError(f'Recording failed: {errors}, {len(stamps)} frames')


if __name__ == '__main__':
    main()
