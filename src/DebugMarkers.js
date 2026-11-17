import * as T from 'three';

const orderedSamples=new WeakMap();

export function markersAt(samples,time,frame){
  if(!orderedSamples.has(samples))orderedSamples.set(samples,[...samples].sort((a,b)=>a.stamp-b.stamp));
  const active=new Map();
  for(const sample of orderedSamples.get(samples)){
    if(sample.stamp>time+1e-6)break;
    const key=sample.source+'|'+sample.name+'|'+sample.id;
    if(sample.action==='clear'){
      for(const [id,item] of active)if(item.source===sample.source)active.delete(id);
    }else if(sample.action==='delete')active.delete(key);
    else active.set(key,sample);
  }
  return [...active.entries()].filter(([,s])=>s.frame_id===frame&&(!s.lifetime||time-s.stamp<s.lifetime));
}

export function updateDebugMarkers(group,samples,time,frame){
  const selected=markersAt(samples,time,frame), wanted=new Set(selected.map(([key])=>key));
  const dispose=object=>{object.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});group.remove(object);};
  for(const child of [...group.children])if(!wanted.has(child.name))dispose(child);
  for(const [key,sample] of selected){
    const previous=group.children.find(o=>o.name===key);
    if(previous?.userData.sample===sample)continue;
    if(previous)dispose(previous);
    const color=new T.Color(...sample.color.slice(0,3));
    let object;
    if(sample.type==='ellipsoid'){
      object = new T.Group();
      const surface = new T.Mesh(new T.SphereGeometry(1,24,16), new T.MeshBasicMaterial({
        color, transparent:true, opacity:sample.color[3], depthWrite:false, side:T.DoubleSide,
      }));
      const outline = new T.Mesh(new T.SphereGeometry(1,16,12), new T.MeshBasicMaterial({
        color, transparent:true, opacity:.55, depthWrite:false, wireframe:true, side:T.DoubleSide,
      }));
      object.add(surface, outline);
      object.position.fromArray(sample.position);
      object.quaternion.fromArray(sample.orientation).normalize();
      object.scale.fromArray(sample.scale.map(x=>x/2));
    }else if(sample.type==='arrow'&&sample.points?.length===2){
      const start=new T.Vector3(...sample.points[0]),delta=new T.Vector3(...sample.points[1]).sub(start);
      if(delta.length()<1e-8)continue;
      object=new T.ArrowHelper(delta.clone().normalize(),start,delta.length(),color,Math.min(.2,delta.length()/3),.08);
    }else continue;
    object.name=key;object.userData.sample=sample;group.add(object);
  }
}
