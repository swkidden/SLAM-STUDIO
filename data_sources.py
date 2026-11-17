"""Uniform read interface for active streams, SQLite recordings and indexed projects."""
import bisect
import re
from archive import reader, image as archive_image

class DataSources:
    def __init__(self, live, sessions):
        self.live, self.sessions = live, sessions

    def info(self, key, history=False):
        if key in self.live.sessions:
            if history:
                return self.live.load_recording(key)['data']
            return self.live.sessions[key].snapshot()
        if key.startswith('live_'):
            return self.live.load_recording(key)['data']
        return self.sessions[key]['data']

    def window(self, key, start, end):
        data = self.info(key, history=True)
        if start > end: raise ValueError('Invalid time window')
        result = dict(data)
        result['tracks'] = []
        for track in data['tracks']:
            poses = track['poses']; stamps = [p[0] for p in poses]
            lo = max(0, bisect.bisect_left(stamps, start)-1)
            hi = bisect.bisect_right(stamps, end)+1
            result['tracks'].append(dict(track, poses=poses[lo:hi]))
        result['cameras'] = []
        for stream in data['cameras']:
            lo = max(0, bisect.bisect_left(stream['stamps'], start)-1)
            hi = bisect.bisect_right(stream['stamps'], end)+1
            c = dict(stream, stamps=stream['stamps'][lo:hi])
            # For ordinary indexed bags retain global array indices.
            c['frame_ids'] = stream.get('frame_ids', list(range(len(stream['stamps']))))[lo:hi]
            result['cameras'].append(c)
        return result

    def frame(self, key, camera, frame_id):
        if key in self.live.sessions:
            return self.live.sessions[key].frame(camera, frame_id)
        if key.startswith('live_'):
            if not re.fullmatch(r'live_[0-9a-f]{32}',key): raise ValueError('Invalid recording ID')
            return archive_image(self.live.root / 'cache' / 'recordings' / (key+'.sqlite'), camera, frame_id=frame_id)
        session = self.sessions[key]
        stream = session['data']['cameras'][camera]
        source = session['frame_sources'][camera]
        with reader(source['db']) as conn:
            if stream.get('frame_ids') is not None:
                row = conn.execute('SELECT jpeg FROM frames WHERE camera=? AND frame_id=?',
                                   (source['camera'], frame_id)).fetchone()
            else:
                stamp = session['data']['epoch'] + stream['stamps'][frame_id] - source.get('offset',0)
                row = conn.execute('SELECT jpeg FROM frames WHERE camera=? AND stamp BETWEEN ? AND ? ORDER BY ABS(stamp-?) LIMIT 1',
                                   (source['camera'], stamp-.00001, stamp+.00001, stamp)).fetchone()
        if not row: raise ValueError('Frame not found')
        return row[0]

    def release(self, key):
        # Detach a viewer; ingestion and owned processes have an explicit stop command.
        if not key.startswith('live_'):
            self.sessions.pop(key, None)
        return {'released': key}
