/**
 * 思考强度配置
 *
 * 用于控制模型推理的深度和复杂度
 * - undefined: 不传参数，使用模型默认行为
 * - 'none'/'off'/'disabled': 关闭思考模式
 * - 'low'/'minimal': 轻量思考，速度快
 * - 'medium': 中等思考（部分模型支持）
 * - 'high': 深度思考（推荐默认）
 * - 'max': 最大思考强度
 */
export type ThinkingEffort = "none" | "off" | "disabled" | "low" | "minimal" | "medium" | "high" | "max";

export interface ThinkingConfig {
  /**
   * 思考强度级别
   * @default undefined (使用模型默认行为)
   */
  effort?: ThinkingEffort;
}
