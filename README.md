# HEKA Ephys Workbench

**本工具目前适用于 HEKA PATCHMASTER 下机后保存的电压钳电流记录（bundled DAT）的本地预览与分析。** 打开记录后，可以沿 File → Group → Series 查找 sweep，结合原始标签、记录时间和刺激方案比较各阶段。数据在使用者自己的计算机上解析，仓库只提供软件和测试。

## 安装和启动

建议使用 Python 3.11–3.13。以下命令在下载或克隆的仓库根目录运行。Windows 示例：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\Open_Ephys.cmd
```

macOS / Linux 可用 `python3 -m venv .venv`，再运行 `.venv/bin/python -m pip install -r requirements.txt` 和 `.venv/bin/python launch_platform.py`。启动器只监听本机回环地址，自动打开浏览器。手动启动可运行 `python serve_platform.py --port 8765`，打开 `http://127.0.0.1:8765/ephys_platform.html`。依赖安装完成后可离线使用。

## 从自己的 DAT 开始

1. 首次打开是空库。在页头输入 DAT 文件夹的**完整路径**，点击「扫描 DAT」检查找到的文件，再点击「更新文件列表」。扫描包含子文件夹，成功导入后页面自动载入。首次解析需要磁盘空间存放完整采样缓存。
2. 选择文件与 Group，点击 Series 表中的一行切换参考记录。新 Group 默认显示全部 sweep，并减去 baseline。快捷输入如 `S01W2,S03W4` 可以跨 Series 选曲线。双击「选中 Trace」可切换全选和全不选。
3. 在「Cursor 编辑」设置单点、时间窗或负峰恢复时间。每个 cursor 独立命名并选择统计量。趋势图使用实际 sweep 时间，可按 Series 放大。表格支持按列或按矩形区域复制。
4. 导出统计 CSV、完整采样 Trace CSV、可编辑的 Trace SVG，或 Pulse Generator 的 CSV / JSON / SVG。Protocol SVG 将不同命令方案独立分图，提供电压和时间比例尺。

## 判读与支持范围

- 当前针对时间单位为秒、信号单位为 A 的电流记录。支持关联到单一刺激通道的恒定电压段、线性逐 sweep 电压增量，以及 Store / NoStore。相对电压、延时采集、交织采样、斜坡及其他不支持的编码会报告导入错误。建议先用代表性文件与 PATCHMASTER 核对。
- 屏幕波形保留抽样极值和段边界。Cursor 统计和 Trace CSV 使用完整存储采样。恢复时间以窗内负峰为起点，默认以进入 baseline 容差带（剩余幅度 ≤5%）并持续 1 ms 为终点，单位 ms。缺少采样或未达到判定条件时保留状态信息。
- 程序依据原始标签及时间顺序显示阶段。给药、剂量和 washout 的实验含义需结合记录者的注释判断。Pulse Generator 导出用于查看和绘图。实时采集、设备控制与原生 PGF 写入不在当前支持范围内。

## 保存及迁移

原始 DAT 以只读方式打开。启动后生成的 `outputs/`、`backups/`、文件索引和路径配置均留在本机，并由 Git 默认忽略。Cursor 在同一浏览器和本地地址下跨 DAT 共用，trace 选择按文件及 Group 保存。「导出 cursor」保存测量参数，「导出工程」保存选择、视图、cursor 和人工注释。迁移工程时需要另行准备对应的原始 DAT。

## 运行测试

安装依赖后运行 `python -m unittest -v test_library`，检查空库启动、扫描、错误导入及缓存保护。设置可选环境变量 `HEKA_TEST_DAT` 为自己的受支持 DAT 文件路径，可额外测试完整解码、增量复用和输出索引。测试在临时目录进行。如果安装了 Node.js，可运行 `node test_recovery.cjs` 和 `node test_analysis.cjs` 检查测量、趋势和设置兼容性。

基于 [pyHEKA](https://github.com/delvendahl/pyHEKA) 读取 DAT，使用 NumPy 处理数值，使用 Plotly 在本地绘图。
