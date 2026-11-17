import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import comparison_projects, read_tum, seed_projects


class ComparisonProjectsTests(unittest.TestCase):
    def test_current_results_have_exact_sources(self):
        projects = {p['id']: p for p in comparison_projects()}
        if not projects: self.skipTest('历史400/200点实验源在当前工作区不可用；不作为功能测试失败')
        self.assertEqual(len(projects), 12)
        for project in projects.values():
            methods = {m['name']: m for m in project['methods']}
            self.assertIn('IMU-guided 400', methods)
            self.assertIn('DynaVINS 200', methods)
            self.assertIn('imu_guided_all/run_001', methods['IMU-guided 400']['path'])
            self.assertIn('dynavins_200_15/run_001', methods['DynaVINS 200']['path'])
            for method in project['methods']:
                self.assertGreater(len(read_tum(method)), 100)
            self.assertEqual(project['view']['pathMode'], 'full')
            self.assertEqual('OpenVINS original 400' in methods, project['id'].endswith('3_high'))
        parking = projects['comparison_400_200_parking_lot_3_high']
        self.assertEqual(len(parking['methods']), 4)
        fusion = next(m for m in parking['methods'] if m['name'] == 'VINS-Fusion original 200')
        self.assertIn('original_200_15_run_001/viode_viode_stereo_imu/3_high', fusion['path'])
        for project in projects.values():
            if project is not parking:
                self.assertFalse(any('VINS-Fusion' in m['name'] for m in project['methods']))

    def test_historical_projects_are_not_relabelled(self):
        parking = next(p for p in seed_projects() if p['id'] == 'parking_lot_3_high')
        if not parking['methods']: self.skipTest('历史VINS-Fusion实验源在当前工作区不可用')
        self.assertIn('VINS-Fusion (modified)', [m['name'] for m in parking['methods']])
        self.assertNotIn('[400 / 200]', parking['name'])


if __name__ == '__main__':
    unittest.main()
