import base64
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import numpy as np
import cv2
from live import LiveHub
from data_sources import DataSources
import server

class StreamingTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.hub=LiveHub(Path(self.folder.name))
        self.s=self.hub.create(dict(tracks=[dict(id='v')],cameras=[{}],max_frames=2))
        self.jpeg=cv2.imencode('.jpg',np.zeros((24,32,3),np.uint8))[1].tobytes()
    def tearDown(self):
        self.hub.close();self.folder.cleanup()
    def batch(self,i):
        return dict(poses=[dict(track='v',stamp=100+i,position=[i,0,0],orientation=[0,0,0,1])],frames=[dict(camera=0,stamp=100+i,jpeg=base64.b64encode(self.jpeg).decode())])
    def test_delta_reconnect_and_reset(self):
        self.s.push(self.batch(0));a=self.s.updates(0,0)
        self.assertEqual(a['kind'],'delta');self.assertEqual(a['updates'][0]['poses'][0],['v',0,0.,0.,0.,0.,0.,0.,1.])
        self.s.push(self.batch(1));self.assertEqual(len(self.s.updates(a['cursor'],0)['updates']),1)
        self.s.reset();self.s.push(self.batch(0));self.assertEqual(self.s.updates(a['cursor'],0)['kind'],'snapshot')
        self.s.push(self.batch(10));self.s.push(self.batch(0));self.assertEqual(self.s.generation,2)
        self.assertEqual(self.hub.load_recording(self.s.id)['data']['duration'],0)
    def test_reconnect_outside_journal_sends_snapshot(self):
        for i in range(1030): self.s.push(dict(poses=self.batch(i)['poses']))
        self.assertEqual(self.s.updates(0,0)['kind'],'snapshot')
    def test_history_and_stop_save(self):
        for i in range(5): self.s.push(self.batch(i))
        sources=DataSources(self.hub,{})
        self.assertEqual(sources.frame(self.s.id,0,0),self.jpeg)
        self.assertEqual(sources.window(self.s.id,0,1)['cameras'][0]['frame_ids'],[0,1,2])
        self.s.stop();self.assertEqual(len(sources.info(self.s.id,True)['tracks'][0]['poses']),5)
        self.assertEqual(self.hub.recordings(),[]);self.s.save_recording();self.assertEqual(len(self.hub.recordings()),1)
    def test_archived_counters_match_snapshot(self):
        import json
        self.s.push(dict(self.batch(0),transport_counts=dict(source_frames=1)))
        from archive import reader
        with reader(self.s.archive_path) as c:
            recorded=json.loads(c.execute("SELECT value FROM metadata WHERE key='counts'").fetchone()[0])
        self.assertEqual(recorded,self.s.snapshot()['counts'])

    def test_empty_stop_has_valid_empty_replay(self):
        self.s.stop();data=self.hub.load_recording(self.s.id)['data']
        self.assertEqual(data['duration'],0);self.assertEqual(data['tracks'][0]['poses'],[])

    def test_image_only_archive_and_missing_image(self):
        self.s.push(dict(frames=self.batch(0)['frames']))
        data=self.hub.load_recording(self.s.id)['data'];self.assertEqual(data['tracks'][0]['poses'],[])
        with self.assertRaises(ValueError):self.s.frame_at(0,3)
    def test_trajectory_only_and_truth(self):
        p=Path(self.folder.name)/'a.tum';np.savetxt(p,[[100,0,0,0,0,0,0,1],[101,1,0,0,0,0,0,1]])
        state=dict(id='test');server.prepare_session(dict(methods=[dict(name='v',path=str(p))],truth=dict(path=str(p))),state)
        self.assertEqual(state['status'],'ready',state);self.assertEqual(state['data']['cameras'],[]);self.assertEqual(state['data']['duration'],1)
        self.assertEqual(len(state['data']['tracks']),2)
    def test_temporary_cleanup_and_saved_restart(self):
        self.s.push(self.batch(0));self.s.save_recording();self.s.close()
        other=LiveHub(Path(self.folder.name));other.cleanup_temporary();self.assertEqual(len(other.recordings()),1)
        temp=other.create(dict(tracks=[dict(id='v')]));path=temp.archive_path;temp.stop();self.assertTrue(path.exists());temp.close();self.assertFalse(path.exists());other.close()

    def test_named_connection_profiles_are_persisted_and_replaced(self):
        original=server.CONNECTION_PROFILES
        server.CONNECTION_PROFILES=Path(self.folder.name)/'config'/'profiles.json'
        try:
            first=server.save_connection_profile(dict(name='Camera',config={'ros_master_uri':'http://localhost:11311'}))
            second=server.save_connection_profile(dict(id=first['id'],name='Camera stereo',config={'topics':['/left','/right']}))
            self.assertEqual(len(server.connection_profiles()),1)
            self.assertEqual(server.connection_profiles()[0],second)
            with patch('server.xmlrpc.client.ServerProxy') as proxy:
                proxy.return_value.getPublishedTopics.return_value=(1,'',[('/cam/image_raw','sensor_msgs/Image')])
                self.assertEqual(server.ros_topics('http://localhost:11311'),[dict(name='/cam/image_raw',type='sensor_msgs/Image')])
        finally:
            server.CONNECTION_PROFILES=original
