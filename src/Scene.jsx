import React, {useEffect,useRef,forwardRef,useImperativeHandle} from 'react';
import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {followView,lowerBound,displayPoseAt} from './model';

function frustum(color,scale) {
  const a=.68*scale,b=.43*scale,z=scale;
  const corners=[[-a,-b,z],[a,-b,z],[a,b,z],[-a,b,z]];
  const vertices=[];
  for(let i=0;i<4;i++) vertices.push(0,0,0,...corners[i],...corners[i],...corners[(i+1)%4]);
  const geometry=new T.BufferGeometry(); geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));
  return new T.LineSegments(geometry,new T.LineBasicMaterial({color,transparent:true,opacity:.9}));
}

export default forwardRef(function Scene({data,time,settings},ref) {
  const host=useRef(), poseStatus=useRef(), runtime=useRef(), state=useRef({data,time,settings});
  state.current={data,time,settings};
  useImperativeHandle(ref,()=>({
    getCamera:()=>runtime.current?{position:runtime.current.camera.position.toArray(),target:runtime.current.controls.target.toArray(),quaternion:runtime.current.camera.quaternion.toArray()}:null,
    reset:()=>runtime.current?.reset(),
    render:()=>runtime.current?.draw(),
    canvas:()=>runtime.current?.renderer.domElement,
  }));
  useEffect(()=>{
    if(!data||!host.current)return;
    const renderer=new T.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.outputColorSpace=T.SRGBColorSpace;
    host.current.appendChild(renderer.domElement);
    const scene=new T.Scene();
    const camera=new T.PerspectiveCamera(42,1,.01,10000);camera.up.set(0,0,1);
    const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;
    controls.screenSpacePanning=true;
    const bounds=new T.Box3();
    for(const track of data.tracks)for(const p of track.poses)bounds.expandByPoint(new T.Vector3(...p.slice(1,4)));
    if(bounds.isEmpty())bounds.set(new T.Vector3(-5,-5,0),new T.Vector3(5,5,0));
    const center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3());
    let span=Math.max(size.x,size.y,size.z,3);
    const markerSize=0.07;
    const ground=bounds.min.z-.25;
    const gridSize=Math.max(10,Math.ceil(span*1.6));
    const grid=new T.GridHelper(gridSize,gridSize,0x44534d,0x28332f);
    grid.rotation.x=Math.PI/2;grid.position.set(Math.round(center.x),Math.round(center.y),ground);
    scene.add(grid);
    const axes=new T.AxesHelper(Math.max(1,span*.08));axes.position.copy(center);axes.position.z=ground;scene.add(axes);
    const bodyCamera=new T.Matrix4().set(...(data.project.body_from_camera||[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]).flat());
    const objects=data.tracks.map(track=>{
      const vertices=[],times=[];
      for(let i=1;i<track.poses.length;i++){
        const a=track.poses[i-1],b=track.poses[i];
        if(b[0]-a[0]>data.max_gap)continue;
        vertices.push(...a.slice(1,4),...b.slice(1,4));times.push(b[0]);
      }
      const geometry=new T.BufferGeometry();
      geometry.setAttribute('position',new T.Float32BufferAttribute(data.live?new Float32Array(data.project.max_poses*6):vertices,3));
      const stamps=new Float32Array(geometry.attributes.position.count);
      times.forEach((t,i)=>{stamps[i*2]=t;stamps[i*2+1]=t;});
      geometry.setAttribute('sampleTime',new T.BufferAttribute(stamps,1));
      if(data.live)geometry.attributes.position.setUsage(T.DynamicDrawUsage);
      const material=track.truth?new T.LineDashedMaterial({color:track.color,dashSize:.35,gapSize:.2,transparent:true,opacity:.65}):new T.LineBasicMaterial({color:track.color});
      const fade={displayTime:{value:time},trailDuration:{value:0}};
      material.transparent=true;
      material.onBeforeCompile=shader=>{
        Object.assign(shader.uniforms,fade);
        shader.vertexShader='attribute float sampleTime; varying float vSampleTime;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvSampleTime=sampleTime;');
        shader.fragmentShader='uniform float displayTime; uniform float trailDuration; varying float vSampleTime;\n'+shader.fragmentShader.replace('#include <opaque_fragment>','if(trailDuration>0.0) diffuseColor.a *= clamp(1.0-(displayTime-vSampleTime)/trailDuration,0.0,1.0);\n#include <opaque_fragment>');
      };
      const line=new T.LineSegments(geometry,material);if(track.truth)line.computeLineDistances();scene.add(line);
      // WebGL native lines stay one pixel wide on most drivers. Additional
      // subpixel screen offsets give the trajectory a stable ~2.5 px stroke.
      material.depthWrite=false;
      const strokes=[[.7,0],[-.7,0],[0,.7],[0,-.7]].map(([x,y])=>{
        const copy=material.clone();copy.depthWrite=false;
        copy.onBeforeCompile=shader=>{
          material.onBeforeCompile(shader);
          const pixels=new T.Vector2();renderer.getDrawingBufferSize(pixels);
          shader.uniforms.strokeOffset={value:new T.Vector2(2*x*renderer.getPixelRatio()/pixels.x,2*y*renderer.getPixelRatio()/pixels.y)};
          copy.userData.shader=shader;
          shader.vertexShader='uniform vec2 strokeOffset;\n'+shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\ngl_Position.xy += strokeOffset * gl_Position.w;');
        };
        const stroke=new T.LineSegments(geometry,copy);stroke.frustumCulled=false;scene.add(stroke);
        stroke.userData.offset=[x,y];return stroke;
      });
      if(data.live)line.frustumCulled=false;
      const pose=new T.Group();
      const dot=new T.Mesh(new T.SphereGeometry(markerSize*.35,12,8),new T.MeshBasicMaterial({color:track.color}));
      pose.add(dot);
      const rig=new T.Group();rig.applyMatrix4(bodyCamera);
      const cone=frustum(track.color,settings.frustumLength??0.25);rig.add(cone);pose.add(rig);
      const localAxes=new T.AxesHelper(markerSize*1.5);pose.add(localAxes);
      scene.add(pose);
      return{track,line,strokes,pose,cone,dot,localAxes,times,fade};
    });
    let previousMode='',liveRevision=-1,liveReady=false;
    const reset=()=>{
      const aspect=camera.aspect;
      const halfFov=Math.atan(Math.tan(T.MathUtils.degToRad(camera.fov/2))*Math.min(1,aspect));
      const distance=Math.max(size.length()/2,1.5)/Math.sin(halfFov)*1.08;
      camera.position.copy(center).add(new T.Vector3(.62,-.85,1.2).normalize().multiplyScalar(distance));
      controls.target.copy(center);controls.update();
    };
    const resize=()=>{if(!host.current)return;const {width,height}=host.current.getBoundingClientRect();renderer.setSize(width,height);camera.aspect=width/Math.max(height,1);camera.updateProjectionMatrix();};
    const observer=new ResizeObserver(resize);observer.observe(host.current);resize();reset();
    const draw=()=>{
      const {data,time,settings:s}=state.current;
      const displayPoses=new Map(data.tracks.map(t=>[t.id,displayPoseAt(t.poses,time,data.max_gap,!!data.live)]));
      if((data.live||data.archive)&&liveRevision!==data.revision){
        for(const o of objects){
          o.track=data.tracks.find(t=>t.id===o.track.id)||o.track;
          const needed=Math.max(6,(o.track.poses.length-1)*6);
          if(o.line.geometry.attributes.position.array.length<needed){
            o.line.geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(needed*2),3).setUsage(T.DynamicDrawUsage));
            o.line.geometry.setAttribute('sampleTime',new T.BufferAttribute(new Float32Array(needed*2/3),1).setUsage(T.DynamicDrawUsage));
          }
          const array=o.line.geometry.attributes.position.array;o.times=[];let offset=0;
          for(let i=1;i<o.track.poses.length;i++){
            const a=o.track.poses[i-1],b=o.track.poses[i];
            if(b[0]-a[0]>data.max_gap)continue;
            array.set(a.slice(1,4),offset);array.set(b.slice(1,4),offset+3);offset+=6;o.times.push(b[0]);
            const timestamps=o.line.geometry.attributes.sampleTime.array;
            timestamps[offset/3-2]=b[0];timestamps[offset/3-1]=b[0];
          }
          o.line.geometry.attributes.position.needsUpdate=true;
          o.line.geometry.attributes.sampleTime.needsUpdate=true;
          if(o.track.truth)o.line.computeLineDistances();
        }
        if(!liveReady&&data.tracks.some(t=>t.poses.length)){
          bounds.makeEmpty();for(const t of data.tracks)for(const p of t.poses)bounds.expandByPoint(new T.Vector3(...p.slice(1,4)));
          bounds.getCenter(center);bounds.getSize(size);span=Math.max(size.x,size.y,size.z,3);
          grid.position.set(center.x,center.y,bounds.min.z-.25);axes.position.copy(grid.position);reset();liveReady=true;
        }
        liveRevision=data.revision;
      }
      scene.background=s.camera==='video-follow'?null:new T.Color(s.theme==='dark'?'#131a17':'#f5f8f6');
      grid.visible=s.grid;axes.visible=s.axes;
      grid.material.opacity=s.theme==='dark'?.72:.32;grid.material.transparent=true;
      for(const o of objects){
        const {track}=o,visible=s.visible[track.id]!==false;
        const color=s.colors[track.id]||(track.truth&&s.theme==='light'?'#69766e':track.color);
        o.line.material.color.set(color);o.dot.material.color.set(color);o.cone.material.color.set(color);
        o.line.visible=visible;
        for(const stroke of o.strokes){
          stroke.visible=visible;stroke.material.color.set(color);
          const uniform=stroke.material.userData.shader?.uniforms.strokeOffset;
          if(uniform){const size=renderer.getDrawingBufferSize(new T.Vector2()),[x,y]=stroke.userData.offset;uniform.value.set(2*x*renderer.getPixelRatio()/size.x,2*y*renderer.getPixelRatio()/size.y);}
        }
        const upto=s.pathMode==='full'&&!s.trail?o.times.length:lowerBound(o.times,time+1e-7);
        const from=s.trail>0?lowerBound(o.times,time-s.trail):0;
        o.fade.displayTime.value=time;o.fade.trailDuration.value=s.trail||0;
        o.line.geometry.setDrawRange(from*2,Math.max(0,upto-from)*2);
        const p=displayPoses.get(track.id);o.pose.visible=visible&&!!p;
        if(p){o.pose.position.copy(p.position);o.pose.quaternion.copy(p.quaternion);}
        o.cone.visible=s.frustums;o.localAxes.visible=s.axes;
        o.cone.scale.setScalar((s.frustumLength??.25)/(settings.frustumLength??.25));
      }
      const selected=data.tracks.find(t=>t.id===s.selectedTrack)||data.tracks[0];
      const selectedPose=displayPoses.get(selected?.id);
      renderer.domElement.dataset.frustumVisible=String(!!(selectedPose&&s.frustums&&s.visible[selected?.id]!==false));
      renderer.domElement.dataset.poseAge=String(selectedPose?.age??'');
      if(poseStatus.current){
        poseStatus.current.textContent=data.live&&selectedPose?.age>.12?`位姿滞后 ${(selectedPose.age*1000).toFixed(0)} ms（保持最近位姿）`:'';
      }
      if(s.camera!==previousMode){
        if(s.camera==='top'){
          camera.position.copy(center).add(new T.Vector3(0,-.001,span*1.55/Math.min(camera.aspect,1)));
          controls.target.copy(center);controls.update();
        }else if(s.camera==='orbit')reset();
        if(['orbit','top','fixed'].includes(s.camera)&&s.savedCamera){
          camera.position.fromArray(s.savedCamera.position);controls.target.fromArray(s.savedCamera.target);controls.update();
        }
        previousMode=s.camera;
      }
      controls.enabled=['orbit','top','fixed'].includes(s.camera);
      if(s.camera==='follow'||s.camera==='video-follow'){
        const track=data.tracks.find(t=>t.id===s.selectedTrack)||data.tracks[0];
        const p=displayPoses.get(track?.id);
        if(p){
          const view=followView(p,bodyCamera,s);
          controls.target.copy(view.target);camera.position.copy(view.position);
          camera.up.set(0,0,1);camera.lookAt(view.target);
        }
      }
      if(s.camera==='cinematic'&&s.keyframes.length){
        const keys=[...s.keyframes].sort((a,b)=>a.time-b.time);
        let j=lowerBound(keys,time,k=>k.time);j=Math.min(j,keys.length-1);
        const b=keys[j],a=keys[Math.max(0,j-1)];
        let f=b.time===a.time?0:T.MathUtils.clamp((time-a.time)/(b.time-a.time),0,1);f=f*f*(3-2*f);
        camera.position.fromArray(a.position).lerp(new T.Vector3(...b.position),f);
        controls.target.fromArray(a.target).lerp(new T.Vector3(...b.target),f);
        // Interpolate the camera's up direction to avoid roll singularities at a top view.
        if(a.quaternion&&b.quaternion){
          const rotation=new T.Quaternion(...a.quaternion).slerp(new T.Quaternion(...b.quaternion),f);
          camera.up.set(0,1,0).applyQuaternion(rotation);
        }
        camera.lookAt(controls.target);camera.up.set(0,0,1);
      }
      renderer.render(scene,camera);
    };
    renderer.setAnimationLoop(draw);
    runtime.current={renderer,camera,controls,reset,draw};
    return()=>{
      renderer.setAnimationLoop(null);observer.disconnect();controls.dispose();
      scene.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});
      renderer.dispose();renderer.domElement.remove();runtime.current=null;
    };
  },[data.id,data.generation??0]);
  return <><div ref={host} className="three-scene" aria-label="3D trajectory viewport"/><span ref={poseStatus} className="pose-delay" role="status"/></>;
});
