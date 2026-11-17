import tempfile
import unittest
from pathlib import Path

from server import bag_files


class BagFilesTests(unittest.TestCase):
    def test_lists_only_bag_files_in_selected_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'b.BAG').touch()
            (root/'a.bag').touch()
            (root/'notes.txt').touch()
            (root/'nested').mkdir()
            (root/'nested'/'hidden.bag').touch()
            result=bag_files(directory)
            self.assertEqual([entry['name'] for entry in result['files']],['a.bag','b.BAG'])
            self.assertTrue(all(Path(entry['path']).parent==root for entry in result['files']))

    def test_rejects_missing_directory(self):
        with self.assertRaises(ValueError): bag_files('/not/a/real/bag/folder')
