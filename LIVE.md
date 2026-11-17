# 实时接入与历史回放

启动：`VIO_STUDIO_PORT=8767 bash /root/vins_dev/vio_studio/start.sh`，打开 http://127.0.0.1:8767 。

顶栏“运行算法”支持连接已有算法、启动算法、启动算法并播放 bag。外部算法不归 Studio 管理；停止接入只停止桥接。Studio 启动的算法需要明确点“停止运行”才停止。刷新网页会重连本标签页，关闭网页不会停止算法。重新打开页面后，可在“运行算法”的“重新打开已有运行”中重新打开运行或临时记录。

## 显示与记录

实时数据默认临时完整归档。暂停实时显示后可拖动到初始化阶段和缓存范围以外，播放或逐帧查看历史；接收继续进行。“回到实时”回到最新数据。

停止后保留完整回放，可点“保存记录”长期保存，或“更多 → 丢弃本次记录”删除。保存记录从序列列表重新打开，支持删除。服务退出会清理未保存的临时记录；旧版已保存数据保持兼容。

图像面板显示接收、归档与显示统计；FPS 对应各图像通道实际提交，隐藏通道为零。算法/相机发布较慢时，界面不会生成中间图像。缺帧不会用旧图冒充。

## ROS1

自定义 JSON 示例：`examples/live-astravins-attach.json`（连接现有 AstraVins）及 `examples/live-openvins-1021.json`。ROS master、话题及 `frame_id` 必须和算法实际输出一致。

位姿支持 Odometry、PoseStamped、PoseWithCovarianceStamped、TransformStamped、Path；图像支持 Image 与 CompressedImage。Path 当前只追加最新位姿。可在 cameras 中用 `role: "diagnostic"` 接入算法已有的外点剔除图像。无需在 Studio 重算外点。

高级配置中的 ROS 话题输入会从当前 ROS Master 获取话题名和类型建议，也允许手动输入。连接配置可以命名保存、加载和删除，保存在 `config/connection_profiles.json`（或 `SLAM_STUDIO_DATA_ROOT/config/connection_profiles.json`），只在本机，不进入版本控制。

诊断图像在两帧之间保持最近一帧，并显示图像时间戳相对播放时间的延迟；原图仍按 120 ms 最近帧窗口显示。

ROS 桥接记录其收到的源消息数、上传后的归档数和队列溢出数；不宣称能检测桥接收到消息之前的所有 ROS 丢包。

## 通用 HTTP 接入

```bash
curl --noproxy '*' http://127.0.0.1:8767/api/live \
  -H 'Content-Type: application/json' \
  -d '{"adapter":"http","frame_id":"world","tracks":[{"id":"vio","name":"VIO"}],"cameras":[],"save_recording":false}'
```

返回 id 后向 `/api/live/<id>/samples` POST：

```json
{"poses":[{"track":"vio","stamp":1000.05,"frame_id":"world","position":[1,2,0],"orientation":[0,0,0,1]}],"frames":[]}
```

图像在 cameras 声明后，使用 `{camera:0, stamp:1000.05, jpeg:"BASE64_JPEG"}`；每批最多 2000 位姿、4 张图像，每张 JPEG 不超过 512 KiB。时间为秒、位置为米，四元数 Hamilton xyzw。

## 统一数据接口

| 接口 | 作用 |
|---|---|
| `GET /api/data/<id>` | 实时滚动信息或离线数据 |
| `GET /api/data/<id>?history=1` | 完整归档数据 |
| `GET /api/data/<id>/window?start=0&end=10` | 指定相对时间段索引与位姿，含插值边界样本 |
| `GET /api/data/<id>/frame?camera=0&index=<frame_id>` | 稳定 ID 取图，自动读取已移出内存的帧 |
| `POST /api/data/<id>/release` | 释放查看引用，不停止算法 |
| `GET /api/live/<id>/events` | SSE 位姿与图像索引增量；Last-Event-ID 为 generation:cursor |
| `GET /api/live` | 当前服务内会话列表 |
| `POST /api/live/<id>/stop` | 停止本次接收及其拥有的进程，保留回放 |
| `POST /api/live/<id>/save` | 长期保存，停止后也可调用 |
| `POST /api/live/<id>/discard` | 停止并删除该记录 |
| `POST /api/live/<id>/reset` | 清空本会话历史并增加时间代次，不重置算法 |

旧 `/api/session`、`/api/frame`、`/api/recordings` 和 live 快照/图片接口仍兼容。离线 JSON 使用 methods 的 TUM 路径，可省略 bag、image_topics、truth；已有 bag 工程格式不变。

工程显示设置、相机跟随偏好与记录保存分开；关闭或切换数据源不会重置有效的跟随设置。离线回放保留多算法、真值、视频底图和截图/视频导出。

## 统一算法配置入口（2026-11-13）

“运行算法”弹窗只使用一个“算法配置”下拉框，内置 AstraVins / IMU-guided OpenVINS 与本机配置统一选择。选中后直接显示并编辑 ROS Master、坐标系、位姿/图像话题及消息类型。启动模式还显示工作目录、ROS环境脚本、命令参数（含估计器 YAML 路径）。模板修改后保存为本机副本；本机配置可以保存修改或另存为。

启动/读bag/仅连接使用当前表单同一份配置，不再跳到另一个高级表单。仅连接会省略启动命令；读bag使用独立端口避免混入实时相机。完整JSON入口用于多算法、环境变量等；JSON与可见字段共享状态。原独立 AdvancedLiveDialog 已移除，话题选择组件独立为 TopicPicker。

验证：`tests/unified-config-browser.mjs` 检查模板切换、YAML路径可见、话题/类型编辑、命名保存、选回及运行提交一致性；结果 `test-results/simple_workflow_20261113/unified-browser.log`。启动请求采用HTTP测试替身验证，无额外启动真实算法。

## 通用调试数据

ROS1 桥接器直接订阅 `/diagnostics`，并发现其他 `diagnostic_msgs/DiagnosticArray` 和 `visualization_msgs/MarkerArray` 话题。诊断由原始话题与状态名称标识，字段保持通用键值。数值可绘制曲线，点号命名的较大字段组默认折叠。调试页支持字段搜索、曲线定位及归档回放。标准诊断消息没有单位字段，发布者应在键名或状态说明中明确单位。

HTTP `/api/live/{id}/samples` 在现有 `poses`、`frames` 之外接收可选 `diagnostics`、`markers` 数组。只发送调试数据也可工作。诊断样例为 `{"schema_version":1,"source":"estimator","name":"frontend","stamp":100.0,"message":"updated","values":{"features":8,"elapsed_ms":0.2}}`。stamp 是与传感器相同的绝对秒时间戳，前端与归档读取统一减去会话 epoch。

诊断值支持数值、布尔、字符串与 null。非有限数值存为 null。旧客户端省略新字段，旧归档缺少调试表时返回空数组。新归档使用附加的 debug_samples 表。SSE 快照与增量均携带调试数据，generation 重置时清理历史。迟到的诊断不会自行重置轨迹。

每批最多 1000 条诊断或 marker；每条诊断最多 256 个标量字段，单条 JSON 最大 32 KiB。

三维对象首版支持 SPHERE 椭球和两点 ARROW，包含 source/name/id、stamp、frame_id、position、Hamilton xyzw orientation、直径 scale、RGBA color、lifetime 和 add/delete/clear action。仅显示与工程 frame_id 一致的对象。当前没有 TF 变换器。持久对象的最新状态保留在实时快照中，删除、过期和历史拖动按消息时间处理。工具栏可开关调试三维对象。

验证命令为 `python3 -m unittest discover -s tests`、`node tests/debug-panel-browser.mjs`。真实诊断回放检查使用 `SLAM_STUDIO_RECORDING_ID=<保存记录ID> node tests/debug-replay-browser.mjs`。浏览器测试默认服务端口 8779，可通过 STUDIO_URL 修改。
