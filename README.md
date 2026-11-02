# dsh-pin-running

DSH 插件：把运行中的任务置顶到侧栏顶部的独立「置顶」区。不按目录分组、不拆原文件夹；跑完继续停留且保持绿点；点开后切到别的任务时才移除该项，并始终回到原会话的工作目录。

## 行为

- 运行中的会话自动进入置顶区；清单由插件记在 localStorage（`dsh-pin-running.tasks.v1`），不再调用 DSH 原生 pin/unpin，原文件夹里的行保持原样。
- 运行中：绿点闪烁（脉冲）。跑完：绿点常绿，条目继续留在置顶区。
- 点击一律用 DSH 原生 `openSession` 打开会话，会话自带原 workspace/cwd，会回到原目录。
- 还在运行的任务，点击只切过去查看，条目绝不移除。
- 已完成的任务，点击只是点开查看并记下「已看过」，条目仍在；等你切换到别的任务时，这个已看过且已完成的旧项才从置顶区消失。若一直不切换，它就一直留着。
- 插件加载时已经卡在 `running: true` 的旧会话同样会进入置顶区；判断运行状态以 `uiSession.sessionStatus` 为准。
- 不修改视图模式（分组/单列表由 DSH 自己决定）。唯有一项一次性迁移：若检测到早期版本强制留下的 `groupBy: flat`，会切回原生文件夹分组（`workspace`）并记标记；之后用户手动选择不再干预。
- 同时有多个条目时运行中的排前面，其余按更新时间倒序；区域最高 40vh，内部滚动。

## 实现边界

浏览器半端用 DOM 挂载到侧栏 `regionArea` 的列表上方，因为 DSH 没有暴露「会话列表顶部」的 slot。挂载点按类名的语义后缀匹配：桌面版是 `[class*="_regionArea"]` 内 `[class*="_sectionHeader"]`（「工作区」标题）之后；旧版 CLI 则退回 `.hHd-Xa_regionArea .bhn1Oq_root` 的 `listArea` 之前。构建哈希变化不影响，只有侧栏结构大改才需要同步选择器。

## 安装

先克隆仓库（路径按你的实际位置改）：

```powershell
git clone https://github.com/c66-m/dsh-pin-running.git
```

普通 profile：

```powershell
dsh plugin --profile <name> add link:<本仓库绝对路径>
```

桌面版 profile 由 Electron 独占管理，CLI 的 `dsh plugin --profile desktop ...` 会被拒绝，需手动装：

1. 在 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pin-running` 建一个指向本仓库的 junction：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pin-running" -Target "<本仓库绝对路径>"
   ```

2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

   - `dependencies` 加 `"dsh-pin-running": "link:<本仓库绝对路径，正斜杠>"`
   - `dsh.profile.bundles` 末尾加 `"dsh-pin-running"`

3. 重启 DSH。

## 打包

```powershell
npm pack
```

生成 `dsh-pin-running-0.1.0.tgz`，可直接作为离线安装包分发。

卸载：删掉 package.json 里的依赖与 bundles 条目、删除 node_modules 下的 junction，重启。