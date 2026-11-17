# SLAM Studio 开发接续

## 当前入口

源码目录仍为 `vio_studio`。使用 `bash start.sh` 构建并启动，默认 8765；本机常用服务为 8767。设置 `VIO_STUDIO_PORT=8767` 可指定端口。服务仅监听本机。

本轮修复记录：`test-results/stream_repair_20261113/`，含修改前备份、构建日志、单元测试、浏览器测试及性能原始统计。历史文档已备份在该目录 `before/`，不是当前接口规范。

## 2026-11-13 操作入口简化

顶栏改为“运行算法 / 打开回放”，当前数据名和状态直接显示。`src/LiveDialog.jsx` 提供预置算法与三种输入模式，旧完整表单保留为 `src/AdvancedLiveDialog.jsx`，只在高级设置展开。`src/OpenDialog.jsx` 提供保存记录与 TUM 文件入口。更多菜单收纳展示工程和配置；首次打开不自动挑选历史实验。

停止或读包完成后自动进入起点回放，保存按钮只保存运行记录。原有工程格式、接收和渲染链路保留。本轮没有重启8767服务，保留用户正在运行的会话，刷新即可加载新界面。读bag预置使用随机高端口候选启动master；高级模式仍可指定master。

验证见 `test-results/simple_workflow_20261113/`。主流程浏览器测试使用HTTP输入替代实际启动算法，核对预置启动请求、停止回放保存、打开已有记录与TUM；实时/历史回放与导出继续由 replay-browser 回归覆盖，不将模拟请求说成算法实际运行。

## 模块职责

## 2026-11-13 画面与连接配置

- 诊断图保留最近帧并显示时间差；普通图像仍按120 ms同步窗口。
- 跟随默认1 m/1 m，视锥固定米制长度默认0.25 m；相关偏好全局保存。
- 命名连接配置存于本机 `config/connection_profiles.json`；ROS话题动态发现并允许手动输入。
- 回归：`tests/diagnostic-stale-browser.mjs`、`tests/config-profiles-browser.mjs`、`tests/view-scale-browser.mjs`。

| 模块 | 职责 |
|---|---|
| `server.py` | HTTP 路由、离线工程准备、导出任务；保留旧接口 |
| `data_sources.py` | 实时、记录、离线工程的统一 info/window/frame/release 读取 |
| `live.py` | 接收校验、滚动缓存、增量游标、时间代次、会话与保存状态 |
| `archive.py` | 独立只读 SQLite 连接与历史图像查询；不持有接收锁 |
| `runner.py` | ROS 桥接、Studio 所启动算法和 bag 的进程生命周期 |
| `event_stream.py` | SSE 元数据增量通知及断线续传 |
| `tools/ros_live.py` | ROS 消息转换、上传及桥接队列溢出计数 |
| `src/dataSource.js` | 数据源接口、SSE 合并、受限实时缓存 |
| `src/usePlayback.js` | 历史/离线播放时钟、图像预读与缓存 |
| `src/Frame.jsx` | 图像请求、显示和实际提交后的逐帧计数 |
| `src/Scene.jsx` | 复用 Three.js 场景与轨迹缓冲；跟随/视频底图等展示 |
| `src/main.jsx` | 页面组装、来源选择及用户操作 |

链路：ROS/HTTP → 接收校验 → SQLite 同批归档 → SSE 位姿/索引通知 → 显示缓存。JPEG 走独立 HTTP；通知不传 JPEG。离线 bag 建索引后使用同一读取接口。

SSE 携带递增 cursor 和 generation。浏览器重连以 Last-Event-ID 续传；超过 1024 批通知日志时发送滚动快照。历史永远从 SQLite 查询，通知日志和显示缓存不是完整记录。超过 1 秒的整体时间回跳进入新 generation；显式 reset 也会重置，禁止跨代次连线。普通重复/乱序样本计入 dropped。

## 生命周期

- 接收与播放独立：跟随、暂停、拖动、历史播放都不暂停采集。
- 未保存记录默认临时；停止后仍能回放与保存。明确丢弃才删除；保存后的记录可以跨服务重启读取。
- 页面刷新重连本标签页的会话；关闭页面或切换来源不停止算法。必须用明确的停止按钮停止 Studio 拥有的进程。外部启动的估计器只断开订阅。
- 临时记录在正常服务退出时清理；下次启动清理新格式、所属旧进程已退出的临时记录。不会按此规则清理旧格式实验记录，也不清理其他仍运行服务的临时记录。
- `SLAM_STUDIO_DATA_ROOT` 可隔离测试数据；生产默认沿用原 cache/projects/exports。测试服务必须使用独立端口与数据目录。

## 数据边界

支持 TUM、可选真值、ROS1 bag 原图/算法可视化图、已归档运行记录及纯轨迹。时间统一为源 header.stamp/轨迹时间，米、Hamilton xyzw；本工具不做标定。离线 SE(3) 对齐保持已有行为，实时不伪造对齐误差。

图像匹配最大偏差 120 ms；超出显示缺帧，不保持上一张伪装有效图像。初始化没有轨迹时仍显示原图。Path 适配只追加最新位姿，完整历史回环修正仍未实现。ROS 上游在消息到达桥接前的丢包无法由 Studio 精确计数。

## 验证

```bash
/usr/bin/python3 -m unittest discover -s tests
export PATH="$PWD/.tools/node-v22.15.0-linux-x64/bin:$PATH"
npm run build
STUDIO_URL=http://127.0.0.1:8771 node tests/replay-browser.mjs
STUDIO_URL=http://127.0.0.1:8771 node tests/streaming-browser.mjs
```

运行浏览器验收前先启动独立服务：

```bash
SLAM_STUDIO_DATA_ROOT="$PWD/test-results/local-runtime" /usr/bin/python3 server.py --port 8771
```

性能测试每组 60 秒，25/30 Hz，752×480 双目及诊断 JPEG；前半段显示左右原图，后半段显示诊断图。统计实际图像提交后的 FPS 与 P95 延迟，不用 Three.js 绘制循环代替。每路归档数量必须等于输入。测试使用 Chromium/SwiftShader，结果不代表所有客户端和算法的速度。

`test_comparison_projects.py` 依赖历史实验路径；源数据不可用时明确跳过，不重建或伪造旧实验结果。其余数据读取、状态和回放测试应通过。视频导出保留 `tools/render.mjs` 原流程，新增回归包含纯轨迹离屏截图。

## 统一算法配置入口（2026-11-13）

“运行算法”弹窗只使用一个“算法配置”下拉框，内置 AstraVins / IMU-guided OpenVINS 与本机配置统一选择。选中后直接显示并编辑 ROS Master、坐标系、位姿/图像话题及消息类型。启动模式还显示工作目录、ROS环境脚本、命令参数（含估计器 YAML 路径）。模板修改后保存为本机副本；本机配置可以保存修改或另存为。

启动/读bag/仅连接使用当前表单同一份配置，不再跳到另一个高级表单。仅连接会省略启动命令；读bag使用独立端口避免混入实时相机。完整JSON入口用于多算法、环境变量等；JSON与可见字段共享状态。原独立 AdvancedLiveDialog 已移除，话题选择组件独立为 TopicPicker。

验证：`tests/unified-config-browser.mjs` 检查模板切换、YAML路径可见、话题/类型编辑、命名保存、选回及运行提交一致性；结果 `test-results/simple_workflow_20261113/unified-browser.log`。启动请求采用HTTP测试替身验证，无额外启动真实算法。
# 2026-11-14：原生 Basalt Astra 1021 配置

运行面板增加“Basalt Astra 1021”，来源为 `examples/live-basalt-astra-1021.json`。通过工作区外置接入程序 `/root/vins_dev/basalt_astra_ros1/run.py` 调用原生 Basalt，订阅 Astra 双目和 BMI088，发布 `/basalt/pose`。不含 IMU-guided Filter 和外点诊断图。接入程序、时间补偿及旧 bag 使用说明见 `/root/vins_dev/basalt_astra_ros1/README.md`。默认驱动已补偿 6.51 ms；旧未补偿 bag 需在启动参数中设置 `_image_stamp_compensation_s:=0.0`。

