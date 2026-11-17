import { Quaternion, Vector3 } from 'three';

export const defaults = {
  theme: 'dark', layout: 'scene', camera: 'orbit', pathMode: 'progressive',
  grid: true, frustums: true, axes: false, rate: 1, loop: false, trail: 0,
  visible: {}, colors: {}, names: {}, keyframes: [], selectedTrack: 'method_0',
  followDistance: 1, followHeight: 1, followAngle: 0, frustumLength: 0.25,
  imageCamera: 0,
  inspectionView: 'images', diagnosticCamera: null, debugMarkers: false,
};
export function followView(pose, bodyFromCamera, settings) {
  const up=new Vector3(0,0,1);
  const forward=new Vector3(0,0,1).transformDirection(bodyFromCamera).applyQuaternion(pose.quaternion);
  forward.z=0;
  if(forward.lengthSq()<1e-8){
    const right=new Vector3(1,0,0).transformDirection(bodyFromCamera).applyQuaternion(pose.quaternion);
    forward.crossVectors(up,right);
    if(forward.lengthSq()<1e-8)forward.set(1,0,0);
  }
  forward.normalize().applyAxisAngle(up,(settings.followAngle??0)*Math.PI/180);
  const position=pose.position.clone().addScaledVector(forward,-(settings.followDistance??10));
  position.z+=settings.followHeight??6;
  return {position,target:pose.position.clone()};
}
export function lowerBound(values, value, get = x => x) {
  let lo=0, hi=values.length;
  while(lo<hi) { const mid=(lo+hi)>>1; if(get(values[mid])<value) lo=mid+1; else hi=mid; }
  return lo;
}
export function poseAt(poses, time, maxGap=.25) {
  if(!poses.length || time<poses[0][0]-1e-5 || time>poses.at(-1)[0]+1e-5) return null;
  const j=Math.min(lowerBound(poses,time,p=>p[0]),poses.length-1), b=poses[j];
  if(j===0 || Math.abs(b[0]-time)<1e-5) return {position:new Vector3(...b.slice(1,4)),quaternion:new Quaternion(...b.slice(4,8))};
  const a=poses[j-1];
  if(b[0]-a[0]>maxGap) return null;
  const f=(time-a[0])/(b[0]-a[0]);
  return {position:new Vector3(...a.slice(1,4)).lerp(new Vector3(...b.slice(1,4)),f),
    quaternion:new Quaternion(...a.slice(4,8)).slerp(new Quaternion(...b.slice(4,8)),f)};
}
// Live image and estimator messages arrive independently. Display the latest
// available past pose without extrapolating the estimator state.
export function displayPoseAt(poses,time,maxGap=.25,live=false){
  const interpolated=poseAt(poses,time,maxGap);
  if(interpolated)return {...interpolated,age:0};
  if(!live||!poses.length||time<poses[0][0])return null;
  let index=lowerBound(poses,time,p=>p[0]);
  if(index===poses.length||poses[index][0]>time)index--;
  const sample=poses[index];
  return {...poseAt([sample],sample[0],maxGap),age:Math.max(0,time-sample[0])};
}
export function frameAt(stamps,time) {
  const i=Math.min(lowerBound(stamps,time),stamps.length-1);
  const j=i>0 && Math.abs(stamps[i-1]-time)<Math.abs(stamps[i]-time)?i-1:i;
  return Math.abs(stamps[j]-time)>.12 ? -1 : j;
}
export function frameAtOrBefore(stamps,time) {
  if(!stamps.length)return -1;
  const i=lowerBound(stamps,time);
  if(i<stamps.length&&Math.abs(stamps[i]-time)<1e-9)return i;
  if(i>0)return i-1;
  return Math.abs(stamps[0]-time)<=.12?0:-1;
}
export function frameUrl(data,camera,index) {
  if(index<0)return '';
  const id=data.cameras[camera].frame_ids?.[index]??index;
  return `/api/data/${data.id}/frame?camera=${camera}&index=${id}`;
}
export function clock(t) {
  t=Math.max(0,t);
  return `${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
}
export async function api(path,data) {
  const response=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error||response.statusText);
  return result;
}
