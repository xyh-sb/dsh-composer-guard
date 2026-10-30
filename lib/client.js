/**
 * dsh-composer-guard —— 浏览器半区：输入栏坏了就自动刷新。
 *
 * ## 为什么需要它
 *
 * DSHA 手机端（Android WebView）从后台回到会话时，底部输入栏有三种已知的坏相：
 *
 * 1. **错位**：座位（`[data-composer-seat]`）底边停在键盘弹起时的视口高度上，
 *    卡片悬在屏幕中间偏上；滚动区的横向滚动还可能是 291px，把座位整条推出屏幕。
 * 2. **透明**：卡片背景解析成 `rgba(0, 0, 0, 0)`，白底页面上一块看不见的卡片。
 * 3. **字号归零**：占位文字 computed `font-size` 是 0px，字在 DOM 里但画出来是 0 高。
 *
 * 这三样的共同点是：**盒子几何都对、也都写得回去，可屏幕上就是不对**，而手动刷新
 * 一次页面必定恢复。所以它属于 WebView 回前台后没有按新视口重新布局/光栅化，页内
 * 再怎么写样式都只是往一个坏掉的排版结果上打补丁。这个插件不再修样式，只负责在
 * 判定确实坏了之后把页面重新加载一次（会话数据在服务端，重载后原样回来）。
 *
 * ## 判定与守卫
 *
 * - 先做一次**无副作用的唤醒**（派发 `resize` + 把滚动区的横向滚动归零），200ms 后
 *   再判定 —— 能自己好就不刷。
 * - 页面加载满 5 秒才判定：初次进入时布局本来就在陆续稳定，不该闪。
 * - 判定有两路：恢复类事件（`visibilitychange` / `pageshow` / `focus` / `blur` /
 *   `resize`）之后 900ms 跑一次，**另外每 2.5s 轮询一次** —— 熄屏再亮屏时 Activity
 *   一直 resumed、document 一直 visible，WebView 可能一个事件都不发，只靠事件永远
 *   等不到那次判定。
 * - `sessionStorage` 记次数，最多刷两次；还坏就不再动手，避免死循环。
 * - 所有读数都 try/catch：这是个兜底件，绝不能自己把页面弄挂。
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-guard',
  factory: () => {
    'use strict'

    /** 会话滚动容器（宿主标记）。 */
    const SCROLL = '[data-conversation-scroll]'
    /** 宿主的 composer 座位：绝对/粘附定位在滚动区底部。 */
    const SEAT = '[data-composer-seat]'
    /** 宿主的输入卡片。 */
    const CARD = '[data-composer-card]'
    /** 卡片里的占位文字层。 */
    const PLACEHOLDER = '[class*="_placeholder"]'

    const COUNTER = 'dsh-composer-guard-reloads'
    const MAX_RELOADS = 2
    /** 页面加载后多久才允许判定。 */
    const MIN_AGE_MS = 5000
    /** 恢复事件之后等多久再判定（留给键盘/系统栏收起）。 */
    const AFTER_RESUME_MS = 900
    /** 唤醒之后等多久看效果。 */
    const AFTER_NUDGE_MS = 200
    /**
     * 慢兜底轮询：熄屏/亮屏可能一个事件都不发。走 10s 而不是 2.5s —— 平时真正
     * 干活的是下面的 ResizeObserver（尺寸一变才看），轮询只是最后的保险。
     */
    const POLL_MS = 10000

    /** 诊断上报端（本机 3199，见 README）；打不通就静默，绝不影响页面。 */
    const DIAG_URL = 'http://127.0.0.1:3199/guard'

    function report(kind, detail) {
      try {
        const body = JSON.stringify({
          kind,
          detail: detail ?? null,
          at: new Date().toISOString(),
          count: readCount(),
          hidden: document.hidden,
          innerHeight: Math.round(window.innerHeight),
          views: scrollers().map((scroller) => {
            const seat = scroller.querySelector(SEAT)
            const card = scroller.querySelector(CARD)
            const rect = (element) => {
              if (!(element instanceof HTMLElement)) return 'absent'
              const box = element.getBoundingClientRect()
              return `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`
            }
            return `scroller ${rect(scroller)} seat ${rect(seat)} card ${rect(card)}`
          }),
        })
        void fetch(DIAG_URL, { method: 'POST', mode: 'no-cors', body }).catch(() => {})
      } catch {
        /* 诊断失败不影响页面 */
      }
    }

    function readCount() {
      try {
        return Number(sessionStorage.getItem(COUNTER) ?? '0') || 0
      } catch {
        return 0
      }
    }

    function resetCount() {
      try {
        sessionStorage.setItem(COUNTER, '0')
      } catch {
        /* 存储不可用时放弃守卫，只影响次数上限 */
      }
    }

    function bumpCount() {
      try {
        sessionStorage.setItem(COUNTER, String(readCount() + 1))
      } catch {
        /* 存储不可用时放弃守卫，只影响次数上限 */
      }
    }

    function scrollers() {
      return [...document.querySelectorAll(SCROLL)]
    }

    /**
     * 无副作用的唤醒：派发一次 resize，并把滚动区的横向滚动归零。
     * 键盘弹起时浏览器会把聚焦的输入区滚进可视区，那个横向滚动落在滚动容器上，
     * 座位跟着被横推出屏幕 —— 键盘收起不会自己滚回来，这里顺手归零。
     */
    function nudge() {
      try {
        window.dispatchEvent(new Event('resize'))
      } catch {
        /* 忽略 */
      }
      for (const scroller of scrollers()) {
        if (scroller instanceof HTMLElement && scroller.scrollLeft !== 0) scroller.scrollLeft = 0
      }
    }

    /** 三种坏相任意一条成立就算坏。 */
    function looksBroken() {
      try {
        for (const scroller of scrollers()) {
          if (!(scroller instanceof HTMLElement)) continue
          const seat = scroller.querySelector(SEAT)
          const card = scroller.querySelector(CARD)
          if (!(seat instanceof HTMLElement) || !(card instanceof HTMLElement)) continue
          const scrollerRect = scroller.getBoundingClientRect()
          const seatRect = seat.getBoundingClientRect()
          // 视图还没挂好（0 宽/0 高）时不下结论，免得空会话被误判。
          if (scrollerRect.height <= 0 || seatRect.width <= 0) continue
          if (Math.abs(seatRect.bottom - scrollerRect.bottom) > 2) return true
          if (getComputedStyle(card).backgroundColor === 'rgba(0, 0, 0, 0)') return true
          const placeholder = card.querySelector(PLACEHOLDER)
          if (placeholder instanceof HTMLElement && parseFloat(getComputedStyle(placeholder).fontSize) === 0) return true
        }
      } catch {
        return false
      }
      return false
    }

    function install() {
      const loadedAt = Date.now()
      let timer = 0
      let attemptTimer = 0

      /**
       * 一次判定：先看是不是坏的，是就唤醒一次，200ms 后再看；还是坏就重载。
       * 好的读数一律把配额归还（计数只累计「刷完还坏」的次数）。
       */
      const attempt = () => {
        if (document.hidden) return
        if (Date.now() - loadedAt < MIN_AGE_MS) return
        if (attemptTimer !== 0) return
        if (!looksBroken()) {
          resetCount()
          return
        }
        report('broken', 'nudging')
        nudge()
        attemptTimer = setTimeout(() => {
          attemptTimer = 0
          if (document.hidden) return
          if (!looksBroken()) {
            resetCount()
            return
          }
          if (readCount() >= MAX_RELOADS) return
          bumpCount()
          report('reload')
          location.reload()
        }, AFTER_NUDGE_MS)
      }

      const schedule = () => {
        if (timer !== 0) clearTimeout(timer)
        timer = setTimeout(attempt, AFTER_RESUME_MS)
      }

      // 熄屏再亮屏、切到别的 App 再回来，WebView 有时一个事件都不发
      // （Activity 一直 resumed，document 也一直 visible），所以除了事件还要轮询。
      // 主路径：尺寸一变就看一眼。平时几乎不耗（回调只在盒子尺寸真的变了时跑），
      // 也不像轮询那样每几秒就去读一次样式。
      let resizeTimer = 0
      const onResize = () => {
        if (resizeTimer !== 0) return
        resizeTimer = setTimeout(() => {
          resizeTimer = 0
          attempt()
        }, 120)
      }
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
      const observeViews = () => {
        if (observer === null) return
        observer.disconnect()
        for (const scroller of scrollers()) {
          if (!(scroller instanceof HTMLElement)) continue
          observer.observe(scroller)
          const seat = scroller.querySelector(SEAT)
          if (seat instanceof HTMLElement) observer.observe(seat)
        }
      }
      observeViews()
      const reobserve = setInterval(observeViews, 15000)

      // 最后的保险：慢轮询。熄屏/亮屏这类一个事件都不发的场景靠它兜住。
      const poll = setInterval(attempt, POLL_MS)
      report('boot')

      // 首次装载后的健康检查：开机就是好的，把上一次会话留下的计数清零。
      const bootCheck = setTimeout(() => {
        if (!document.hidden && !looksBroken()) resetCount()
      }, MIN_AGE_MS + 1000)

      document.addEventListener('visibilitychange', schedule)
      window.addEventListener('pageshow', schedule)
      window.addEventListener('focus', schedule)
      window.addEventListener('blur', schedule)
      window.addEventListener('resize', schedule)

      return () => {
        document.removeEventListener('visibilitychange', schedule)
        window.removeEventListener('pageshow', schedule)
        window.removeEventListener('focus', schedule)
        window.removeEventListener('blur', schedule)
        window.removeEventListener('resize', schedule)
        clearInterval(poll)
        clearInterval(reobserve)
        observer?.disconnect()
        if (resizeTimer !== 0) clearTimeout(resizeTimer)
        if (timer !== 0) clearTimeout(timer)
        if (attemptTimer !== 0) clearTimeout(attemptTimer)
        clearTimeout(bootCheck)
      }
    }

    return {
      name: 'dsh-composer-guard',
      apply(ctx) {
        ctx.effect(() => install(), 'dsh-composer-guard: 输入栏坏态自愈')
      },
    }
  },
})
