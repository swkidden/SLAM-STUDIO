import {api} from './model';

export function dataSource(id) {
  return {
    info:history=>api(`/api/data/${id}?history=${history?1:0}`),
    window:(start=0,end=Infinity)=>api(`/api/data/${id}/window?start=${start}&end=${end}`),
    frame:(camera,index)=>`/api/data/${id}/frame?camera=${camera}&index=${index}`,
    release:()=>api(`/api/data/${id}/release`,{}),
    subscribe(seed,onUpdate,onError){
      let value=seed;
      const stream=new EventSource(`/api/live/${id}/events?cursor=${seed.generation}:${seed.revision}`);
      stream.onmessage=({data})=>{
        const event=JSON.parse(data);
        if(event.kind==='snapshot')value=event.data;
        else {
          const reset=event.generation!==value.generation;
          const tracks=value.tracks.map(t=>({...t,poses:reset?[]:[...t.poses]}));
          const cameras=value.cameras.map(c=>({...c,stamps:reset?[]:[...c.stamps],frame_ids:reset?[]:[...c.frame_ids]}));
          for(const batch of event.updates){
            for(const [id,...pose] of batch.poses)tracks.find(t=>t.id===id)?.poses.push(pose);
            for(const [camera,id,stamp,width,height] of batch.frames){
              const c=cameras[camera];c.stamps.push(stamp);c.frame_ids.push(id);c.width=width;c.height=height;
            }
          }
          const cutoff=event.duration-value.project.history_seconds;
          for(const t of tracks){const first=t.poses.findIndex(p=>p[0]>=cutoff);if(first>0)t.poses.splice(0,first);if(t.poses.length>value.project.max_poses)t.poses.splice(0,t.poses.length-value.project.max_poses);}
          for(const c of cameras){const first=c.stamps.findIndex(t=>t>=cutoff);if(first>0){c.stamps.splice(0,first);c.frame_ids.splice(0,first);}const n=c.stamps.length-value.project.max_frames;if(n>0){c.stamps.splice(0,n);c.frame_ids.splice(0,n);}c.count=c.stamps.length;}
          const primary=tracks.find(t=>!t.truth)||tracks[0];
          const available=[primary?.poses.at(-1)?.[0],cameras[0]?.stamps.at(-1)].filter(t=>t!==undefined);
          value={...value,...event,revision:event.cursor,tracks,cameras,live:true,start:0,time:cameras[0]?.stamps.at(-1)??(available.length?Math.max(...available):event.duration)};
        }
        onUpdate(value);
        if(value.status==='stopped')stream.close();
      };
      stream.onerror=()=>onError?.('reconnecting');
      return ()=>stream.close();
    }
  };
}
