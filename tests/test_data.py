import tempfile
import unittest
from pathlib import Path
import sys
import numpy as np
from scipy.spatial.transform import Rotation
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import read_tum, align_trajectory, association, validate_transform, image_array, transform_trajectory


class DataTests(unittest.TestCase):
    def test_alignment_does_not_fit_scale(self):
        t=np.linspace(0,10,200)
        points=np.column_stack([np.sin(t),np.cos(t),t*.1])
        truth=np.column_stack([t,points,np.tile([0,0,0,1],(len(t),1))])
        est=truth.copy()
        rot=Rotation.from_euler('z',.4)
        est[:,1:4]=rot.apply(points)+[1,2,3]
        est[:,4:8]=rot.as_quat()
        result,stats=align_trajectory(est,truth,'se3')
        self.assertLess(stats['rmse'],1e-10)
        np.testing.assert_allclose(result[:,4:8],truth[:,4:8],atol=1e-10)
        est[:,1:4]*=2
        self.assertGreater(align_trajectory(est,truth,'se3')[1]['rmse'],.2)

    def test_gap_exclusion(self):
        truth=np.array([[0,0,0,0,0,0,0,1],[1,1,1,1,0,0,0,1],[1.1,2,2,2,0,0,0,1]])
        est=truth.copy();est[:,0]=[0,.5,1.05]
        valid,_=association(est,truth,.25)
        self.assertEqual(valid.tolist(),[True,False,True])

    def test_conventions_and_extrinsic(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'a.tum'
            q=Rotation.from_euler('z',.5).as_quat()
            np.savetxt(p,[[0,0,0,0,*q],[1,0,0,0,*q]])
            spec={'path':str(p),'quaternion_convention':'jpl','orientation':'world_to_sensor',
                  'time_offset':2,'sensor_from_body':[[1,0,0,1],[0,1,0,0],[0,0,1,0],[0,0,0,1]]}
            data=read_tum(spec)
            np.testing.assert_allclose(data[0,4:8],q)
            np.testing.assert_allclose(data[0,1:4],Rotation.from_quat(q).apply([1,0,0]))
            self.assertEqual(data[0,0],2)

    def test_invalid_transform(self):
        a=np.eye(4);a[0,0]=2
        with self.assertRaises(ValueError):validate_transform(a)

    def test_ned_display_transform(self):
        original=np.array([[0,1,2,-3,0,0,0,1],[1,2,3,-4,0,0,0,1]],dtype=float)
        result=transform_trajectory(original,np.diag([1,-1,-1,1]))
        np.testing.assert_allclose(result[0,1:4],[1,-2,3])
        # VIODE optical image-down is body +Z, which must become display -Z.
        down=Rotation.from_quat(result[0,4:8]).apply([0,0,1])
        np.testing.assert_allclose(down,[0,0,-1],atol=1e-10)
        self.assertEqual(original[0,3],-3)
        self.assertAlmostEqual(np.linalg.norm(result[1,1:4]-result[0,1:4]),np.linalg.norm(original[1,1:4]-original[0,1:4]))

    def test_exact_endpoint_across_gap(self):
        truth=np.array([[0,0,0,0,0,0,0,1],[10,1,1,1,0,0,0,1]])
        valid,_=association(truth,truth,.25)
        self.assertEqual(valid.tolist(),[True,True])

    def test_invalid_quaternion_convention(self):
        with self.assertRaises(ValueError):
            read_tum({'path':'unused','quaternion_convention':'unknown'})

    def test_rgb_padded_rows(self):
        class Msg:
            encoding='rgb8';height=1;width=2;step=8
            data=bytes([255,0,0,0,255,0,0,0])
        a=image_array(Msg())
        self.assertEqual(a[0,0].tolist(),[0,0,255])


if __name__=='__main__':unittest.main()
