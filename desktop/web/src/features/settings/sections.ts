// fe-settings-paged：设置子页清单（每页独立路由）。

export interface SettingSection {
  slug: string
  label: string
  description: string
}

export const SETTING_SECTIONS: SettingSection[] = [
  { slug: 'devices', label: '设备管理', description: '管理已连接的本机与远端设备' },
  { slug: 'sync', label: '同步', description: '跨设备同步与中继配置' },
  { slug: 'model', label: '模型与 Key', description: '默认模型、API Key 与路由' },
  { slug: 'appearance', label: '外观', description: '主题、语言与显示偏好' },
  { slug: 'permissions', label: '权限', description: 'Agent 能力边界与授权' },
  { slug: 'about', label: '关于', description: '版本、更新与开源信息' },
]
