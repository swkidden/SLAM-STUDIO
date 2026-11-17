import math
import unittest
from live import LiveHub
from data_sources import DataSources


def diagnostic(stamp, **kwargs):
    return dict(source='test', name='tracker', stamp=stamp, values={'points': 8}, **kwargs)


class DebugStreamTests(unittest.TestCase):
    def setUp(self):
        self.hub = LiveHub()
        self.session = self.hub.create(dict(tracks=[dict(id='vio')], cameras=[]))

    def tearDown(self):
        self.hub.close()

    def test_diagnostic_only_ingestion_sse_and_archive(self):
        self.session.push(dict(diagnostics=[diagnostic(100)]))
        snapshot = self.session.snapshot()
        self.assertEqual(snapshot['diagnostics'][0]['stamp'], 0)
        self.assertEqual(snapshot['status'], 'receiving')
        event = self.session.updates(0, 0)
        self.assertEqual(event['updates'][0]['diagnostics'][0]['values']['points'], 8)
        self.assertEqual(self.hub.load_recording(self.session.id)['data']['diagnostics'], snapshot['diagnostics'])
        self.assertEqual(DataSources(self.hub, {}).window(self.session.id, 0, 1)['diagnostics'], snapshot['diagnostics'])
        self.session.save_recording()
        self.assertEqual(self.hub.recordings()[0]['id'], self.session.id)

    def test_late_diagnostic_does_not_reset_motion(self):
        self.session.push(dict(poses=[dict(track='vio', stamp=100, position=[0,0,0], orientation=[0,0,0,1])]))
        self.session.push(dict(diagnostics=[diagnostic(95)]))
        self.assertEqual(self.session.generation, 0)
        self.assertEqual(len(self.session.snapshot()['tracks'][0]['poses']), 1)

    def test_nonfinite_values_and_invalid_version(self):
        sample = diagnostic(10)
        sample['values']['uncertainty'] = math.inf
        self.session.push(dict(diagnostics=[sample]))
        self.assertIsNone(self.session.snapshot()['diagnostics'][0]['values']['uncertainty'])
        with self.assertRaises(ValueError):
            self.session.push(dict(diagnostics=[diagnostic(11, schema_version=2)]))
        self.assertEqual(len(self.session.snapshot()['diagnostics']), 1)

    def test_reset_clears_debug_samples_and_old_archive_loads(self):
        self.session.push(dict(diagnostics=[diagnostic(100)]))
        self.session.reset()
        self.assertEqual(self.session.snapshot()['diagnostics'], [])
        self.assertEqual(self.hub.load_recording(self.session.id)['data']['diagnostics'], [])
        self.session.archive.execute('DROP TABLE debug_samples')
        self.session.archive.commit()
        self.assertEqual(self.hub.load_recording(self.session.id)['data']['diagnostics'], [])

    def test_feature_failure_details_fit_with_summary_fields(self):
        sample = diagnostic(100)
        sample['values'] = {f'feature.{i}': 'insufficient_baseline' for i in range(100)}
        sample['values'].update({f'metric.{i}': i for i in range(30)})
        self.session.push(dict(diagnostics=[sample]))
        self.assertEqual(len(self.session.snapshot()['diagnostics'][0]['values']), 130)
        sample['values'] = {str(i): i for i in range(257)}
        with self.assertRaises(ValueError):
            self.session.push(dict(diagnostics=[sample]))

    def test_marker_validation_and_archive(self):
        marker = dict(source='test',name='ellipsoid',id=0,stamp=100,frame_id='world',type='ellipsoid',
                      position=[1,2,3],orientation=[0,0,0,1],scale=[2,4,6],color=[1,0,0,.2])
        self.session.push(dict(markers=[marker]))
        self.assertEqual(self.hub.load_recording(self.session.id)['data']['markers'][0]['scale'], [2,4,6])
        with self.assertRaises(ValueError):
            self.session.push(dict(markers=[dict(marker, orientation=[0,0,0,0])]))

    def test_persistent_marker_survives_snapshot_history_eviction(self):
        marker = dict(source='test',name='persistent',id=0,stamp=0,frame_id='world',type='ellipsoid',
                      position=[0,0,0],orientation=[0,0,0,1],scale=[1,1,1],color=[1,0,0,.2])
        self.session.push(dict(markers=[marker]))
        for batch in range(7):
            self.session.push(dict(markers=[dict(marker, name='moving', stamp=1+batch*1000+i) for i in range(1000)]))
        self.assertTrue(any(m['name']=='persistent' for m in self.session.snapshot()['markers']))


if __name__ == '__main__':
    unittest.main()
