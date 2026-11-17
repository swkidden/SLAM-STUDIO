"""SQLite archive reads use short-lived read-only connections, independent of ingestion."""
from contextlib import contextmanager
import sqlite3

@contextmanager
def reader(path):
    conn = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True, timeout=5)
    try:
        yield conn
    finally:
        conn.close()


def image(path, camera, stamp=None, frame_id=None, epoch=0):
    with reader(path) as conn:
        if frame_id is not None:
            row = conn.execute('SELECT jpeg FROM frames WHERE camera=? AND frame_id=?',
                               (camera, frame_id)).fetchone()
        else:
            absolute = epoch + stamp
            before = conn.execute('SELECT stamp,jpeg FROM frames WHERE camera=? AND stamp<=? ORDER BY stamp DESC LIMIT 1', (camera, absolute)).fetchone()
            after = conn.execute('SELECT stamp,jpeg FROM frames WHERE camera=? AND stamp>=? ORDER BY stamp LIMIT 1', (camera, absolute)).fetchone()
            near = min((r for r in (before, after) if r), key=lambda r: abs(r[0]-absolute), default=None)
            row = (near[1],) if near and abs(near[0]-absolute) <= .12 else None
        if row is None:
            raise ValueError('No image at the requested time')
        return row[0]
