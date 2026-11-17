import base64
import sqlite3
import unittest

import cv2
import numpy as np
from unittest.mock import patch

from live import LiveHub


def pose(stamp, **kwargs):
    return dict(track='vio', stamp=stamp, position=[stamp, 0, 0], orientation=[0, 0, 0, 2], **kwargs)


class LiveTests(unittest.TestCase):
    def setUp(self):
        self.hub = LiveHub()
        self.session = self.hub.create(dict(tracks=[dict(id='vio')], cameras=[{}], max_frames=2, max_poses=100))
        ok, jpg = cv2.imencode('.jpg', np.zeros((24, 32, 3), np.uint8))
        self.jpg = jpg.tobytes()
        self.encoded = base64.b64encode(self.jpg).decode()

    def tearDown(self):
        self.hub.close()

    def frame(self, stamp):
        return dict(camera=0, stamp=stamp, jpeg=self.encoded)

    def test_empty_and_push(self):
        self.assertEqual(self.session.snapshot()['status'], 'waiting')
        self.session.push(dict(poses=[pose(100), pose(101)], frames=[self.frame(100.5)]))
        s = self.session.snapshot()
        self.assertEqual(s['epoch'], 100)
        self.assertEqual(s['time'], .5)
        self.assertEqual(s['duration'], 1)
        self.assertEqual(s['tracks'][0]['poses'][0][-1], 1)
        self.assertEqual(s['status'], 'receiving')
        self.assertEqual(self.session.frame(0, s['cameras'][0]['frame_ids'][0]), self.jpg)

    def test_bounds_and_duplicates(self):
        self.session.push(dict(poses=[pose(i) for i in range(200)]))
        self.session.push(dict(poses=[pose(199), pose(190)]))
        s = self.session.snapshot()
        self.assertEqual(len(s['tracks'][0]['poses']), 100)
        self.assertEqual(s['counts']['dropped'], 2)
        self.session.push(dict(frames=[self.frame(i) for i in range(197, 200)]))
        self.assertEqual(len(self.session.snapshot()['cameras'][0]['stamps']), 2)
        self.assertEqual(self.session.frame(0, 0), self.jpg)
        self.session.push(dict(poses=[pose(500)]))
        self.assertEqual(len(self.session.snapshot()['tracks'][0]['poses']), 1)
        self.assertEqual(self.session.frame_bytes, 0)

    def test_reset_and_stop(self):
        self.session.push(dict(frames=[self.frame(1)]))
        old = self.session.snapshot()['cameras'][0]['frame_ids'][0]
        self.session.reset()
        self.session.push(dict(frames=[self.frame(0)]))
        s = self.session.snapshot()
        self.assertEqual(s['generation'], 1)
        self.assertGreater(s['cameras'][0]['frame_ids'][0], old)
        self.session.stop()
        self.assertEqual(self.session.snapshot()['status'], 'stopped')
        with self.assertRaises(ValueError): self.session.push(dict(poses=[pose(1)]))

    def test_archive_keeps_frames_evicted_from_live_buffer(self):
        self.session.push(dict(poses=[pose(i) for i in range(4)],
                              frames=[self.frame(i) for i in range(4)]))
        self.session.push(dict(poses=[pose(4)], frames=[self.frame(4)]))
        self.assertEqual(len(self.session.snapshot()['cameras'][0]['stamps']), 2)
        self.assertEqual(self.session.frame_at(0, 0), self.jpg)
        recording = self.hub.load_recording(self.session.id)
        self.assertEqual(len(recording['data']['tracks'][0]['poses']), 5)
        self.assertEqual(recording['data']['cameras'][0]['stamps'], [0, 1, 2, 3, 4])
        self.assertEqual(recording['data']['cameras'][0]['frame_ids'], [0, 1, 2, 3, 4])
        self.assertEqual(self.hub.recordings(), [])
        self.session.save_recording()
        self.assertEqual([row['id'] for row in self.hub.recordings()], [self.session.id])
        source = recording['frame_sources'][0]
        with sqlite3.connect(source['db']) as conn:
            row = conn.execute('SELECT jpeg FROM frames WHERE camera=? AND frame_id=?',
                               (source['camera'], 0)).fetchone()
        self.assertEqual(row[0], self.jpg)

    def test_recording_delete_requires_stopped_session_and_removes_archive(self):
        self.session.push(dict(poses=[pose(1), pose(2)]))
        path=self.session.archive_path
        with self.assertRaises(ValueError): self.hub.delete_recording(self.session.id)
        self.session.stop()
        self.hub.delete_recording(self.session.id)
        self.assertFalse(path.exists())
        self.assertNotIn(self.session.id,self.hub.sessions)

    def test_unsaved_run_survives_stop_until_close_and_can_save_after_stop(self):
        temporary = self.hub.create(dict(tracks=[dict(id='temporary')], save_recording=False))
        temporary_path = temporary.archive_path
        temporary.push(dict(poses=[dict(pose(1), track='temporary'), dict(pose(2), track='temporary')]))
        temporary.stop()
        self.assertTrue(temporary_path.exists())
        self.assertEqual(len(self.hub.load_recording(temporary.id)['data']['tracks'][0]['poses']),2)
        temporary.save_recording()
        temporary.close()
        self.assertTrue(temporary_path.exists())
        self.hub.delete_recording(temporary.id)
        self.assertNotIn(temporary.id, [row['id'] for row in self.hub.recordings()])

        saved = self.hub.create(dict(tracks=[dict(id='saved')], save_recording=False))
        saved.push(dict(poses=[dict(pose(1), track='saved'), dict(pose(2), track='saved')]))
        saved.save_recording()
        saved.stop()
        self.assertTrue(saved.archive_path.exists())
        self.assertIn(saved.id, [row['id'] for row in self.hub.recordings()])

    def test_runner_accepts_algorithm_without_bag(self):
        config = dict(adapter='ros1', ros_master_uri='http://localhost:11311',
                      tracks=[dict(id='vio', topic='/pose', type='geometry_msgs/PoseStamped')],
                      runner=dict(commands=[dict(id='algorithm', argv=['/bin/true'])]))
        with patch('live.LiveSession.start_ros'):
            session = self.hub.create(config)
        self.assertIsNone(session.config['runner'].get('bag'))
        session.stop()

    def test_reject_invalid(self):
        for batch in [dict(poses=[pose(1, frame_id='wrong')]), dict(poses=[pose(float('nan'))]),
                      dict(poses=[dict(pose(1), orientation=[0, 0, 0, 0])]), dict(poses=[1]), dict(poses=None),
                      dict(frames=[dict(self.frame(1), jpeg='invalid')])]:
            with self.assertRaises(ValueError): self.session.push(batch)
        self.assertEqual(self.session.snapshot()['counts']['poses'], 0)
        for config in [dict(tracks=[None]), dict(tracks='bad'), dict(tracks=[{}, {}], frame_id=''),
                       dict(tracks=[dict(id='same'), dict(id='same')])]:
            with self.assertRaises(ValueError): self.hub.create(config)

    def test_session_limit(self):
        for _ in range(3): self.hub.create(dict(tracks=[{}]))
        with self.assertRaises(ValueError): self.hub.create(dict(tracks=[{}]))
        self.session.stop()
        self.hub.create(dict(tracks=[{}]))
        self.assertEqual(sum(not s.ended for s in self.hub.sessions.values()), 4)
