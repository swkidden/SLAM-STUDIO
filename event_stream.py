"""Server-sent events carry metadata only; JPEGs use independent HTTP requests."""
import json
import time

def serve(handler, session, cursor=-1, generation=-1):
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/event-stream')
    handler.send_header('Cache-Control', 'no-cache')
    handler.send_header('X-Accel-Buffering', 'no')
    handler.send_header('Connection', 'close')
    handler.close_connection = True
    handler.end_headers()
    try:
        while True:
            event = session.updates(cursor, generation)
            cursor = event['cursor']
            generation = event.get('generation', event.get('data',{}).get('generation', generation))
            event_id = f'{generation}:{cursor}'
            handler.wfile.write(('id: '+event_id+'\ndata: '+json.dumps(event,separators=(',',':'))+'\n\n').encode())
            handler.wfile.flush()
            if session.ended: break
            # Coalesce bursts while comfortably exceeding 30 Hz source updates.
            time.sleep(.004)
    except (BrokenPipeError, ConnectionResetError, TimeoutError):
        pass
