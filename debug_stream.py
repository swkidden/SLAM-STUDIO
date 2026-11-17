"""Versioned, bounded diagnostic samples shared by ROS and HTTP sources."""
import json
import math


def validate_samples(samples, markers=False):
    if not isinstance(samples, list) or len(samples) > 1000:
        raise ValueError('Expected at most 1000 debug samples')
    result = []
    for sample in samples:
        if not isinstance(sample, dict) or sample.get('schema_version', 1) != 1:
            raise ValueError('Unsupported debug schema')
        value = dict(sample)
        value['stamp'] = float(value['stamp'])
        if not math.isfinite(value['stamp']):
            raise ValueError('Invalid debug timestamp')
        for key in ('source', 'name'):
            if not isinstance(value.get(key), str) or not 0 < len(value[key]) <= 256:
                raise ValueError('Invalid debug ' + key)
        if markers:
            if not isinstance(value.get('id', 0), int):
                raise ValueError('Invalid marker id')
            points = value.get('points', [])
            if not isinstance(points, list) or len(points) > 2 or any(not isinstance(v, list) or len(v) != 3 or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in v) for v in points):
                raise ValueError('Invalid marker points')
            if value.get('action', 'add') not in ('add', 'delete', 'clear'):
                raise ValueError('Invalid marker action')
            if value.get('action', 'add') == 'add':
                for key, size in (('position', 3), ('orientation', 4), ('scale', 3), ('color', 4)):
                    vector = value.get(key)
                    if not isinstance(vector, list) or len(vector) != size or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in vector):
                        raise ValueError('Invalid marker ' + key)
                if sum(x*x for x in value['orientation']) < 1e-12 or min(value['scale']) < 0:
                    raise ValueError('Invalid marker pose')
                if not isinstance(value.get('frame_id'), str):
                    raise ValueError('Missing marker frame')
                lifetime = value.get('lifetime', 0)
                if not isinstance(lifetime, (int, float)) or not math.isfinite(lifetime) or lifetime < 0:
                    raise ValueError('Invalid marker lifetime')
        else:
            fields = value.get('values', {})
            if not isinstance(fields, dict) or len(fields) > 256:
                raise ValueError('Invalid diagnostic fields')
            value['values'] = {str(k): (None if isinstance(v, float) and not math.isfinite(v) else v) for k,v in fields.items()}
            if any(v is not None and not isinstance(v, (str, bool, int, float)) for v in value['values'].values()):
                raise ValueError('Diagnostic values must be scalars')
        if len(json.dumps(value)) > 32768:
            raise ValueError('Debug sample too large')
        result.append(value)
    return result


def relative_samples(samples, epoch):
    return [dict(s, stamp=s['stamp']-epoch) for s in samples]


def load_samples(conn, kind, epoch):
    exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='debug_samples'").fetchone()
    if not exists:
        return []
    return relative_samples([json.loads(row[0]) for row in conn.execute('SELECT payload FROM debug_samples WHERE kind=? ORDER BY stamp, id', (kind,))], epoch)
