#!/usr/bin/python3
"""Import the recorded Astra comparison without aligning or modifying its poses."""
import argparse
import json
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT.parent/'imu_guided_outlier_filter_ws/src/open_vins/results/astra_102703_humanwalking'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--imu-run', default='rt_visualization')
    parser.add_argument('--ransac-run', default='ransac_visualization')
    parser.add_argument('--project-id', default='astra_102703_humanwalking')
    parser.add_argument('--title', default='Astra / 102703 Human Walking')
    args = parser.parse_args()
    calibration = yaml.safe_load('\n'.join(line for line in
        (RESULTS/args.imu_run/'config/kalibr_imucam_chain.yaml').read_text().splitlines() if not line.startswith('%')))
    project = dict(id=args.project_id, name=args.title, dataset='Astra',
        alignment='none', bag='/root/1021/102703_humanwalking_ros1.bag',
        image_topics=[calibration[f'cam{i}']['rostopic'] for i in range(2)],
        body_from_cameras=[calibration[f'cam{i}']['T_imu_cam'] for i in range(2)],
        body_from_camera=calibration['cam0']['T_imu_cam'], max_pose_gap=.25,
        methods=[], diagnostic_images=[],
        view=dict(camera='orbit', pathMode='full', layout='split', inspectionView='diagnostics',
                  diagnosticCamera=2, selectedTrack='method_0'))
    checks = {}
    for folder, baseline, name, color in (
            (args.imu_run, 'rt_static', 'IMU-guided + RT', '#71b4ff'),
            (args.ransac_run, 'ransac_static', 'RANSAC', '#edab64')):
        run = RESULTS/folder
        recording = json.loads((run/'trackhist.json').read_text())
        if recording['errors'] or recording['count'] < 3000:
            raise ValueError('Incomplete visualization recording: '+folder)
        state = np.loadtxt(run/'state.txt')
        original = np.loadtxt(RESULTS/baseline/'state.txt')
        if not np.isfinite(state).all() or np.any(np.diff(state[:, 0]) <= 0):
            raise ValueError('Invalid trajectory: '+folder)
        same_epochs = state.shape == original.shape and np.array_equal(state[:, 0], original[:, 0])
        checks[folder] = dict(same_epochs=same_epochs, poses=len(state), recording=recording,
            max_position_change_m=float(np.linalg.norm(state[:, 5:8]-original[:, 5:8], axis=1).max()) if same_epochs else None,
            endpoint_distance_from_initial_origin_m=float(np.linalg.norm(state[-1, 5:8])))
        trajectory = run/'trajectory.tum'
        np.savetxt(trajectory, np.c_[state[:, 0]-state[:, 17], state[:, 5:8], state[:, 1:5]], fmt='%.9f',
                   header='camera timestamp; IMU position; Hamilton IMU-to-world xyzw')
        config = yaml.safe_load('\n'.join(line for line in (run/'config/estimator_config.yaml').read_text().splitlines()
                                          if not line.startswith('%')))
        thresholds = (f"RANSAC {config['frontend_ransac_klt_threshold_px']} px" if name == 'RANSAC' else
                      f"Reprojection {config['imu_guided_outlier_filter_reprojection_threshold_px']} px, "
                      f"epipolar {config['imu_guided_outlier_filter_epipolar_threshold_px']} px")
        project['methods'].append(dict(name=name, color=color, path=str(trajectory),
            note=f'SCH1633, 200 points, startup-only ZUPT; {thresholds}; same run as visualization. No ground truth alignment.'))
        project['diagnostic_images'].append(dict(bag=str(run/'trackhist.bag'), topic=recording['recorded_topic'], label=name))
    (ROOT/'projects').mkdir(exist_ok=True)
    (ROOT/'projects'/f'{project["id"]}.json').write_text(json.dumps(project, indent=2)+'\n')
    (RESULTS/f'{project["id"]}_checks.json').write_text(json.dumps(checks, indent=2)+'\n')
    print(json.dumps(checks, indent=2))


if __name__ == '__main__':
    main()
