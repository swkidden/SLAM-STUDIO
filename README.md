# SLAM Studio

开发接续请先阅读 [HANDOFF.md](HANDOFF.md)：包含实现状态、测试、后续计划和实验来源。

面向实时监看与论文展示的 SLAM 回放器。多算法轨迹、姿态、真值与双目图像在同一时间轴回放；支持拖动、逐帧、倍速、镜头关键帧、工程保存和 PNG / MP4 导出。

应用已改名为 SLAM Studio；为兼容现有命令和工程路径，源码目录暂保留 `vio_studio`。

## 启动

```bash
bash /root/vins_dev/vio_studio/start.sh
```

打开 http://127.0.0.1:8765 。端口占用时使用 `VIO_STUDIO_PORT=8766 bash /root/vins_dev/vio_studio/start.sh`。

当前机器已安装依赖。迁移机器需要 Node.js 22、Python 3 的 numpy/scipy/OpenCV/rosbag、ffmpeg，以及 `npm ci` 和 `npx playwright install chromium`。无需启动 ROS master。

## 常用操作

- **运行算法**：选 AstraVins 或 IMU-guided OpenVINS，再选实时相机、读取 bag 或连接已有算法。读 bag 只需选择文件并点击“运行并播放”。
- **打开回放**：选择已保存记录；或切到“轨迹文件”填写 TUM 路径。真值、图像可选。
- **停止运行**后自动回到开头，点播放检查结果；点击**保存记录**才长期保留。
- 话题、ROS Master 和自定义 JSON 收进“其他算法 / 高级设置”；展示工程和数据配置位于顶栏“更多”。
- 初次打开不再自动加载某个旧实验。运行中的画面可暂停、拖动历史，用“回到实时”继续跟随。

## 数据和展示

- 预置本工作区 12 个 VIODE 序列，引用最终备份中的 IMU-guided、RANSAC、历史 DynaVINS 和真值；不修改实验数据。
- 夜间 `0_none` 和 `3_high` 接入历史 VINS-Fusion 双目+IMU 结果，来自 `evo_results_catkin_ws_original_after_port/viode_viode_stereo_imu_original_config/`，标为 `VINS-Fusion (historical)`。日志确认 motion filter 关闭，但未验证源码是否为纯净上游版本，不应作为已经核实的原版基线。
- `parking_lot/3_high` 接入新跑的 VINS-Fusion 结果，位于 `/root/vins_dev/experiment_data/vins_fusion/results/viode/run_001/`，包含配置与标定快照、运行清单、日志和 evo 结果；使用现有修改过的 VINS-Fusion 工作区二进制，明确关闭 motion filter 和后端外点预处理，不宣称是未经修改的上游构建。
- 工具栏打开数据源 JSON，可替换 bag、图像话题及 TUM 轨迹路径；不依赖某个 VIO 算法。示例见 [examples/project.json](examples/project.json)。第一版支持 ROS1 bag 和 TUM 轨迹。
- 时间来自图像 `header.stamp` 和轨迹文件首列，统一为秒。图像选最近帧，偏差大于 120 ms 显示缺帧；姿态用平移线性插值与四元数 SLERP，超过 `max_pose_gap` 的间隙不连线、不插值。
- 仅有轨迹时可省略 bag、image_topics 和 truth；初始化阶段只有图像时也可显示与回放。
- TUM 文件每行 `timestamp tx ty tz qx qy qz qw`，空格分隔，允许 `#` 注释；真值可省略，此时不计算 APE、不做对齐。
- 默认轨迹为米、`qx qy qz qw`、Hamilton、传感器到世界的旋转。每条轨迹可指定时间缩放/偏移、单位缩放、四元数约定和 `sensor_from_body`。`body_from_camera` 将相机坐标变换到显示机体坐标，用于视锥和跟随方向。
- 查看器使用 Z-up。VIODE 真值为 Z-down，因此预置工程通过 `display_world_from_world = diag(1,-1,-1,1)` 同时转换所有轨迹的位置和姿态；相机外参仍在机体系中使用。该显示变换在误差计算之后应用，不修改原始文件或 APE/RPE。其他数据默认不转换，可在工程中指定相应刚体变换。
- `alignment: "se3"` 对每条估计轨迹独立做全序列刚体对齐，不拟合尺度；`"none"` 保留原坐标。轨迹不做平滑。APE 为各轨迹自身匹配时间上的位置 RMSE，真值插值后计算，**不是共同时间窗口 Common APE，也不保证与 evo 离散关联结果完全相同**。
- 左侧切换自由/俯视/跟随/固定/关键帧镜头。鼠标拖动旋转、滚轮缩放；空格播放暂停，左右键逐帧。展示设置中调整布局、区间、尾迹、图例和镜头关键帧。
- 跟随镜头根据 `body_from_camera` 的光轴和机体姿态计算水平航向，镜头随转弯转动，保持世界 Z 轴竖直，不随横滚倾斜。在展示设置中选择跟随目标并调节距离、高度、侧向角度；跟随模式由这些参数控制视角。垂直光轴时以相机横轴确定水平参考方向，拖动与离屏导出使用相同的确定性计算。
- 主画面右侧镜头工具栏选择“视频跟随”（位于“跟随”下面的摄像机图标）。它与普通跟随使用同一个三维场景和同一套镜头计算，仅将同步视频放在轨迹后面作为底图；不是第一人称 AR 投影，也不是视锥贴图。
- 展示设置仍使用原来的跟随目标、距离、高度和角度；“视频底图”选择左/右目。轨迹范围、网格、视锥、显隐和颜色也复用原控件。不需要为底图提供相机内参或单独选择真值参考，不声称轨迹与视频物体几何贴合。
- 工程使用 `view.camera: "video-follow"` 和 `view.imageCamera: 0` 保存此模式。旧投影版的 `videoOverlay`、`referenceTrack`、`overlayPathMode` 等字段不再使用；旧工程需手动选择“视频跟随”。底图保持原图比例，缺帧显示缺帧状态，导出等待对应图像解码。
- 展示画面只保留序列名、图例、图像和时间，去掉对齐方式、尺度标签、方法数量和坐标读数；仅清理文字，不改变对齐或指标计算。
- 导出为无控件的 16:9 画面，支持 720p/1080p/4K、24/30/60 fps。视频按固定时间步离屏渲染，不受交互回放掉帧影响；图像仍遵循原始采样率，不生成中间图像。软件渲染时导出可能慢于实时。

## 文件位置

Astra 人行动态场景可通过 `?project=astra_102703_humanwalking` 打开。右侧“外点剔除”面板直接显示算法发布的可视化图像，支持来源切换和放大，不重新推断或绘制外点。离线工程可添加 `diagnostic_images: [{"bag":"/path/tracks.bag","topic":"/tracks/compressed","label":"Algorithm"}]`；图像 `header.stamp` 应与原始图像处于同一时间基准。实时接入见 [LIVE.md](LIVE.md)。

| 内容 | 目录 |
| --- | --- |
| 图像索引与 JPEG 缓存 | `cache/` |
| 保存的展示工程 | `projects/` |
| 视频、截图与导出配置 | `exports/` |
| 浏览器验收截图 | `test-results/` |

第一次打开序列需要建立图像缓存；原始 bag 只读，展示缓存采用 JPEG 质量 90，不应用于算法评估。上述目录均已加入 `.gitignore`。保存工程会同时下载 JSON，内含数据路径、显示设置、镜头及展示区间，不打包原始数据。

## 验证和边界

```bash
cd /root/vins_dev/vio_studio
/usr/bin/python3 -m unittest discover -s tests
export PATH="$PWD/.tools/node-v22.15.0-linux-x64/bin:$PATH"
npm run test:browser
node tests/video-follow-browser.mjs
node tests/follow.mjs
node tests/follow-browser.mjs
node tests/export.mjs
```

浏览器测试需要服务运行在 8765。请依次运行，后端一次只允许一个导出任务。视频跟随测试生成 `exports/slam_studio_video_follow.mp4`（1 秒 720p），截图位于 `test-results/video-follow-*.png`；`tests/export.mjs` 另验证三维镜头的 2 秒导出与工程保存。旧 `slam_studio_image_mapping.mp4` 和 `slam_studio_video_overlay.mp4` 均为被替换方案的历史样片。

支持实时接入、启动算法、启动算法并播放 bag；暂停、拖动和单步操作只控制展示，不回滚算法内部状态。临时归档停止后仍能回放与保存，接口和生命周期见 [LIVE.md](LIVE.md)。暂不读取特征点/残差/动态掩码通道，不凭图像伪造叠加。1021 数据需要使用已标定并统一坐标系的轨迹与真值，本工具不执行手眼或时间标定。服务仅监听本机，不应直接暴露到公网。实时刷新使用 SSE 增量通知，JPEG 独立读取；不再受旧版 100 ms 轮询限制。

## 统一算法配置入口（2026-11-13）

“运行算法”弹窗只使用一个“算法配置”下拉框，内置 AstraVins / IMU-guided OpenVINS 与本机配置统一选择。选中后直接显示并编辑 ROS Master、坐标系、位姿/图像话题及消息类型。启动模式还显示工作目录、ROS环境脚本、命令参数（含估计器 YAML 路径）。模板修改后保存为本机副本；本机配置可以保存修改或另存为。

启动/读bag/仅连接使用当前表单同一份配置，不再跳到另一个高级表单。仅连接会省略启动命令；读bag使用独立端口避免混入实时相机。完整JSON入口用于多算法、环境变量等；JSON与可见字段共享状态。原独立 AdvancedLiveDialog 已移除，话题选择组件独立为 TopicPicker。

验证：`tests/unified-config-browser.mjs` 检查模板切换、YAML路径可见、话题/类型编辑、命名保存、选回及运行提交一致性；结果 `test-results/simple_workflow_20261113/unified-browser.log`。启动请求采用HTTP测试替身验证，无额外启动真实算法。
