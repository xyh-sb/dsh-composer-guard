/**
 * dsh-composer-guard —— 宿主半区。**故意是空壳**。
 *
 * 这里一行业务逻辑都没有，只做两件事：
 * 1) 导出 `name`，让插件树里有一个可识别的 entry；
 * 2) 不声明任何 `inject`。
 *
 * 为什么连 `inject` 都不写：模块级 inject 是硬依赖，缺一个服务这个 entry 就会永远
 * pending，dsh 会判定「1 entry did not activate」，整棵 plugin tree 起不来、Web 直接
 * 白屏。真正的活儿全在浏览器半区（lib/client.js），宿主侧不需要任何服务。
 */
export const name = 'dsh-composer-guard'

export function apply() {}
