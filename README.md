# dsh-composer-guard

> 手机端 DSH Web GUI 的兜底守卫：**从后台回到会话后，如果底部输入栏已经坏了，就自动刷新一次页面。**

DSH（DeepSeek Harness）的 Web 界面在手机 WebView 里（尤其是 Android + 深色/浅色主题切换、软键盘、熄屏这些场景）会偶发一种状态：底部输入栏「看着没了」。

尺寸全都还在，就是画不出来，或者位置跑偏。三种已知的坏相：

| 坏相 | 现象 | 真实读数 |
| --- | --- | --- |
| 错位 | 只看得见一排图标贴在屏幕最下沿，卡片悬在中间偏上 | 座位 `[data-composer-seat]` 底边停在键盘弹起时的视口高度（如 477），而滚动区底边其实是 806 |
| 透明 | 白底页面上那块是空的 | 卡片 `[data-composer-card]` 的 `background` 解析成 `rgba(0, 0, 0, 0)` |
| 字号归零 | 字在 DOM 里但完全看不见 | 占位文字 computed `font-size: 0px` |

手动刷新页面必定恢复。所以这个插件不再试图修样式，只负责**在判定确实坏了之后，把页面重新加载一次**（会话数据在服务端，重载后原样回来）。

## 判定

每次恢复之后（`visibilitychange` / `pageshow` / `focus` / `blur` / `resize`）900ms 检查一次，另外：

- **尺寸驱动**：`ResizeObserver` 盯着滚动区和座位，盒子尺寸一变就看一眼（静止时几乎零开销）；
- **慢轮询**：每 10 秒一次，兜住熄屏再亮屏这种「一个事件都不发」的场景（Activity 一直 resumed，document 一直 visible）。

判定流程：发现坏相 → 先做一次无副作用的唤醒（派发 `resize`、把滚动区的横向滚动归零）→ 200ms 后再看 → 还坏才刷新。

## 守卫

- 页面加载满 **5 秒**才判定，初次进入不会闪。
- 计数只累计「**刷完还坏**」的次数，上限 2 次；只要有一次恢复到好的状态，配额立刻归还。所以限制只防死循环，不影响你下次再遇到坏态。
- 所有读数都包在 `try/catch` 里：这是兜底件，不能自己把页面弄挂。
- 宿主半区是空壳，不声明任何 `inject`——缺服务不会让整棵插件树 pending、把 Web 拖垮。

## 安装

```bash
git clone https://github.com/xyh-sb/dsh-composer-guard.git /root/dsha-composer-guard
```

在 profile 的 `package.json` 里加两项（`~/.dsh/profiles/web/package.json`）：

```jsonc
{
  "dependencies": { "dsh-composer-guard": "link:/root/dsha-composer-guard" },
  "dsh": { "profile": { "bundles": [ /* ... */, "dsh-composer-guard" ] } }
}
```

再建软链并重启 `dsh web`（bundles 是启动时读的）：

```bash
ln -sfn ../../../../dsha-composer-guard ~/.dsh/profiles/web/node_modules/dsh-composer-guard
```

## 为什么是「刷新」而不是「修样式」

2026-10-30 的一整轮真机排查（Android 17 / WebView，390×844）结论是：坏态里盒子几何全都算得出来、也写得回去，写完之后像素仍然不对；而手动刷新一次必定恢复。这属于 WebView 回前台后没有按新视口重新布局/光栅化——页内改样式只是往一个已经坏掉的排版结果上打补丁。

所以本插件刻意保持「侦察 + 重载」的最小职责，不碰任何布局。

## 已知边界

- 只针对手机窄屏（依赖 DSH Web 的 `[data-conversation-scroll]` / `[data-composer-seat]` / `[data-composer-card]` 标记）；桌面端不会触发。
- 刷新会中断页面内的滚动位置与未提交的输入草稿（DSH 自己会持久化草稿，但取决于版本）。
- 它治的是「回前台后画不出来」这个症状，不是根因；根因在 WebView 层。

## License

MIT
