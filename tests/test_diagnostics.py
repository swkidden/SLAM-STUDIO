import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from live import LiveHub


class DiagnosticTests(unittest.TestCase):
    def test_separate_bags_share_epoch_not_duration(self):
        with tempfile.TemporaryDirectory() as folder:
            track = Path(folder)/'a.tum'
            np.savetxt(track, [[101, 0, 0, 0, 0, 0, 0, 1], [102, 1, 0, 0, 0, 0, 0, 1]])
            project = dict(bag='raw', image_topics=['/left'], methods=[dict(name='VIO', path=str(track))],
                           diagnostic_images=[dict(bag='rendered', topic='/tracks', label='Filter', time_offset=.5)])
            def bag(p, s):
                diagnostic = p['bag'] == 'rendered'
                stamps = [101., 102.]+[105.] if diagnostic else [100., 104.]
                return Path(p['bag']), [dict(topic=p['image_topics'][0], stamps=stamps, width=752, height=480)]
            session = dict(id='test')
            with patch.object(server, 'prepare_bag', side_effect=bag):
                server.prepare_session(project, session)
            self.assertEqual(session['status'], 'ready')
            self.assertEqual(session['data']['epoch'], 100)
            self.assertEqual(session['data']['duration'], 4)
            self.assertEqual(session['data']['cameras'][1]['stamps'], [1, 2, 5])
            self.assertEqual(session['data']['cameras'][1]['role'], 'diagnostic')
            self.assertEqual(session['frame_sources'][1], dict(db='rendered', camera=0, offset=.5))
            self.assertEqual(session['data']['tracks'][0]['rmse'], None)

    def test_live_image_role_is_preserved(self):
        hub = LiveHub()
        session = hub.create(dict(tracks=[dict(id='vio')], cameras=[dict(topic='/left'), dict(topic='/right'),
                                  dict(topic='/tracks', role='diagnostic', label='Filter')]))
        self.assertEqual(session.snapshot()['cameras'][2]['role'], 'diagnostic')
        self.assertEqual(session.snapshot()['cameras'][2]['label'], 'Filter')
        with self.assertRaises(ValueError):
            hub.create(dict(tracks=[dict(id='vio')], cameras=[dict(role='unknown')]))


if __name__ == '__main__':
    unittest.main()
