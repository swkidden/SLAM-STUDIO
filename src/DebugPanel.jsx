import React, {useMemo, useState} from 'react';
import './debug.css';

const speeds = [
  {key: 'velocity_imu', label: 'IMU 预测速度', color: '#eeb95b'},
  {key: 'velocity_visual', label: 'SLAM 修正后', color: '#68b8ef'},
  {key: 'velocity_final', label: '最终优化速度', color: '#78ce9c'},
];
const reasons = {
  insufficient_observations: '观测不足',
  ill_conditioned_triangulation: '三角化病态',
  depth_out_of_range: '深度越界',
  insufficient_baseline: '基线不足',
  initialization_chi2_rejected: '卡方拒绝',
  invalid_jacobian: '雅可比无效',
  nonfinite_depth: '深度无效',
  nonfinite_refinement: '优化无效',
  refined_depth_out_of_range: '优化深度越界',
};
function display(value) {
  if (value === undefined || value === null) return '—';
  return typeof value === 'number' ? value.toFixed(3) : String(value);
}
function velocityValue(values, stage, axis, mode) {
  const value = values[`${stage}.${axis}`];
  if (mode === 'speed') return value;
  const components = axis === 'norm' ? ['0', '1', '2'] : [axis];
  const correction = [];
  for (const component of components) {
    const prior = values[`velocity_imu.${component}`];
    const posterior = values[`${stage}.${component}`];
    if (!Number.isFinite(prior) || !Number.isFinite(posterior)) return null;
    correction.push(posterior - prior);
  }
  return axis === 'norm' ? Math.hypot(...correction) : correction[0];
}

function failureText(values) {
  let text = values.promotion_failure;
  if (text === undefined) {
    text = Object.entries(values).filter(([key]) => key.startsWith('failure.'))
      .map(([key, value]) => `${key.slice(8)}=${value}`).join(', ');
  }
  if (!text || text === 'none') {
    const statuses = {no_candidate: '无可提升轨迹', startup_delay: '等待提升', capacity_full: '路标名额已满', disabled: '提升已关闭', attempted: '无失败'};
    return statuses[values.promotion] || '无';
  }
  for (const [key, label] of Object.entries(reasons).sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(key, label);
  return text;
}

export default function DebugPanel({data, time, onTime}) {
  const [source, setSource] = useState('');
  const [axis, setAxis] = useState('norm');
  const [mode, setMode] = useState('speed');
  const [metric, setMetric] = useState('slam_features');
  const groups = useMemo(() => {
    const result = new Map();
    for (const sample of data.diagnostics || []) {
      const id = `${sample.source}|${sample.name}`;
      if (!result.has(id)) result.set(id, {name: sample.name, samples: [], keys: new Set()});
      const group = result.get(id);
      group.samples.push(sample);
      Object.keys(sample.values || {}).forEach(key => group.keys.add(key));
    }
    for (const group of result.values()) group.samples.sort((a, b) => a.stamp - b.stamp);
    return result;
  }, [data.diagnostics]);
  const selected = groups.get(source) || [...groups.values()].find(group => group.keys.has('slam_features')) || groups.values().next().value;
  const samples = selected?.samples || [];
  let current;
  for (const sample of samples) {
    if (sample.stamp > time + 1e-6) break;
    current = sample;
  }
  const values = current?.values || {};
  const actions = {visual_boost: '视觉约束增强', velocity_damping: '弱方向速度抑制', mixed: '增强与速度抑制'};
  const statusText = actions[values.degeneracy] || ({weak: '弱约束', no_constraint: '缺少 SLAM 约束', invalid: '分析无效'}[values.analysis]) || current?.message;

  const start = Math.max(0, time - 20), end = Math.max(20, time);
  const history = samples.filter(sample => sample.stamp >= start && sample.stamp <= end).map(sample => {
    if (mode === 'speed') return sample;
    const fields = {...sample.values};
    for (const stage of speeds) {
      const key = `${stage.key}.${axis}`;
      fields[key] = velocityValue(sample.values, stage.key, axis, mode);
    }
    return {...sample, values: fields};
  });
  const x = stamp => (stamp - start) / (end - start) * 600;
  function curve(series, height, label) {
    const numbers = history.flatMap(sample => series.map(item => sample.values[item.key])).filter(Number.isFinite);
    const bound = 2 ** Math.ceil(Math.log2(Math.max(mode === 'correction' ? .001 : 1, ...numbers.map(Math.abs))));
    const y = value => 16 + (bound - value) / (2 * bound) * (height - 32);
    return <svg viewBox={`0 0 600 ${height}`} role="img" aria-label={label}
      onClick={event => {
        const box = event.currentTarget.getBoundingClientRect();
        onTime(start + (end - start) * (event.clientX - box.left) / box.width);
      }}>
      <line x1="0" x2="600" y1={y(0)} y2={y(0)} className="debug-grid"/>
      <text x="4" y="12">{bound}</text><text x="4" y={height - 4}>{-bound}</text>
      {series.map(item => {
        let path = '', previous;
        for (const sample of history) {
          const value = sample.values[item.key];
          if (!Number.isFinite(value)) { previous = undefined; continue; }
          const connected = previous !== undefined && sample.stamp - previous < .35;
          path += `${connected ? 'L' : 'M'}${x(sample.stamp)},${y(value)} `;
          previous = sample.stamp;
        }
        return <path key={item.key} d={path} stroke={item.color} fill="none" strokeWidth="2"/>;
      })}
      <line x1={x(time)} x2={x(time)} y1="0" y2={height} className="debug-cursor"/>
    </svg>;
  }
  const series = speeds.map(item => ({...item, key: `${item.key}.${axis}`}));
  return <section className="debug-panel" aria-label="通用调试面板">
    <div className="debug-heading">
      <select aria-label="调试来源" value={[...groups].find(([, group]) => group === selected)?.[0] || ''} onChange={event => setSource(event.target.value)}>
        {!groups.size && <option value="">等待诊断数据</option>}
        {[...groups].map(([id, group]) => <option key={id} value={id}>{group.name}</option>)}
      </select>
      <span>{current ? (time - current.stamp > .5 ? '数据过期' : statusText) : '等待数据'}</span>
    </div>
    <div className="debug-summary">
      <div><span>SLAM 特征数</span><strong>{values.slam_features ?? '—'}</strong></div>
      <div><span>提升状态</span><strong title={failureText(values)}>{current ? failureText(values) : '—'}</strong></div>
    </div>
    <div className="debug-chart-heading"><select aria-label="速度视图" value={mode} onChange={event => setMode(event.target.value)}>
      <option value="speed">速度 · m/s</option><option value="correction">修正量 · m/s</option>
      </select>
      <select aria-label="速度分量" value={axis} onChange={event => setAxis(event.target.value)}>
        <option value="norm">模长</option><option value="0">X</option><option value="1">Y</option><option value="2">Z</option>
      </select>
    </div>
    <div className="debug-speed-chart">{curve(series, 210, '速度对比曲线')}</div>
    <div className="debug-legend">{series.map(item => <div key={item.key} style={{color: item.color}}>
      <span>{item.label}</span><strong>{display(velocityValue(values, item.key.slice(0, item.key.lastIndexOf('.')), axis, mode))}</strong>
    </div>)}</div>
    <div className="debug-times"><span>{start.toFixed(1)} s</span><span>{end.toFixed(1)} s</span></div>
    <details className="debug-extra"><summary>其他指标</summary>
      <select aria-label="调试字段" value={metric} onChange={event => setMetric(event.target.value)}>
        <option value="slam_features">slam_features</option>
        {[...(selected?.keys || [])].filter(key => key !== 'slam_features').sort().map(key => <option key={key}>{key}</option>)}
      </select>
      <strong>{display(values[metric])}</strong>
      {curve([{key: metric, color: '#68b8ef'}], 110, '调试字段曲线')}
    </details>
  </section>;
}
