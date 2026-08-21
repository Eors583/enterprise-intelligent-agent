# 管理后台 UI 样式规范表

本规范是管理后台字体、颜色、边距、圆角、阴影、控件尺寸和动效的唯一产品基准。可执行变量位于 `apps/admin/src/styles/design-tokens.css`；本文负责说明使用语义和评审规则。修改视觉规范时先修改 Token 表及本文，再调整组件，不在业务组件中直接写颜色值或随意尺寸。

## 1. 使用规则

1. React 业务组件不得通过 `style={{ ... }}` 编写视觉样式。
2. 颜色只能使用 `--color-*` 语义 Token；十六进制和 `rgb()` 只允许出现在 Token 源文件中。
3. 字号、字重、行高使用 `--font-*` Token。
4. `padding`、`margin`、`gap` 使用 `--space-*` Token；确需新增尺度时先登记 Token，不能在组件样式中临时写数值。
5. 圆角使用 `--radius-*`，阴影使用 `--shadow-*`，控件高度使用 `--control-*`。
6. 知识库等复杂模块可以定义 `--knowledge-*` 组件 Token，但组件 Token 必须引用基础或语义 Token；不可复制一套无登记的颜色和间距。
7. 响应式断点、1px 边框、图标画布和必须与外部内容匹配的固有尺寸可以保留专用值，但需要有明确布局含义，不能用于替代字号、颜色或常规间距 Token。

## 2. 字体规范

| 用途         | Token                    | 当前值                          | 使用场景                           |
| ------------ | ------------------------ | ------------------------------- | ---------------------------------- |
| 默认字体     | `--font-family-sans`     | Inter、苹方、微软雅黑及系统字体 | 全部产品界面                       |
| 展示字体     | `--font-family-display`  | Georgia                         | 极少量品牌标记，不用于业务正文     |
| 等宽字体     | `--font-family-mono`     | 系统等宽字体栈                  | 代码、哈希和机器标识               |
| 辅助微文案   | `--font-size-2xs`        | 8px                             | 空间卡片的极短说明，避免长正文使用 |
| 次级状态     | `--font-size-xs`         | 10px                            | 数量、时间、状态补充               |
| 辅助说明     | `--font-size-sm`         | 11px                            | 表单帮助、树节点说明               |
| 正常控件文字 | `--font-size-md`         | 12px                            | 按钮、标签、导航、列表标题         |
| 强调说明     | `--font-size-lg`         | 13px                            | 表单图例、上传提示                 |
| 模块标题     | `--font-size-xl`         | 16px                            | 卡片和工作区标题                   |
| 区域标题     | `--font-size-heading`    | 24px                            | 登录、概览等强调区域标题           |
| 页面标题     | `--font-size-2xl`        | 29px                            | 一级页面标题                       |
| 展示标题     | `--font-size-hero`       | 36px–58px 响应式                | 登录欢迎区，业务页面禁止使用       |
| 正常字重     | `--font-weight-regular`  | 450                             | 正文与说明                         |
| 中等字重     | `--font-weight-medium`   | 600                             | 轻强调                             |
| 半粗字重     | `--font-weight-semibold` | 650                             | 摘要、选中说明                     |
| 粗体         | `--font-weight-bold`     | 700                             | 按钮、标题、关键标签               |
| 重粗体       | `--font-weight-heavy`    | 800                             | Eyebrow、步骤标记                  |

所有 `button`、`input`、`textarea`、`select`、`option` 和 `optgroup` 必须显式使用控件字体 Token，不能只依赖浏览器继承。尤其是原生下拉浮层：Windows/Chromium 可能在展开后忽略 `select` 的继承值，因此选项必须直接声明 `--control-font-family`、`--control-font-size`、`--control-font-weight` 和 `--control-line-height`，防止展开前后字号跳变。

## 3. 颜色规范

| 语义       | Token                          | 使用规则                   |
| ---------- | ------------------------------ | -------------------------- |
| 主文字     | `--color-text-primary`         | 标题、正文和重要数值       |
| 次文字     | `--color-text-secondary`       | 说明、时间、非关键标签     |
| 三级文字   | `--color-text-tertiary`        | 列表补充信息和弱提示       |
| 禁用文字   | `--color-text-disabled`        | 禁用、空状态的弱信息       |
| 页面背景   | `--color-surface-page`         | 应用主背景                 |
| 主表面     | `--color-surface-primary`      | 卡片、弹窗和输入区域       |
| 弱表面     | `--color-surface-subtle`       | 列表悬浮、分组区域         |
| 选中表面   | `--color-surface-selected`     | 当前知识库、选中的存放位置 |
| 默认边框   | `--color-border-default`       | 卡片和普通分割线           |
| 强边框     | `--color-border-strong`        | 悬浮、拖拽和强调边界       |
| 主操作     | `--color-action-primary`       | 上传、保存等主要动作       |
| 主操作悬浮 | `--color-action-primary-hover` | 主按钮悬浮和深色强调       |
| 危险操作   | `--color-action-danger`        | 删除、不可逆风险           |
| 焦点环     | `--color-focus-ring`           | 键盘焦点，不得移除         |

次级与三级文字在 `--color-surface-primary`、`--color-surface-subtle` 和
`--color-surface-selected` 上必须达到 WCAG AA 正常文本 `4.5:1` 对比度。不得为了制造“弱提示”
而在业务样式中直接写浅灰色；表头、辅助说明、账号标识、表格次级信息和非活动状态统一使用
`--color-text-secondary` 或 `--color-text-tertiary`。禁用控件才可使用
`--color-text-disabled`，且必须同时有原生 `disabled` 语义或等效无障碍状态。

原始色阶 `--color-ink-*`、`--color-brand-*`、`--color-neutral-*` 只用于构造语义 Token。业务样式优先使用语义 Token，不直接依赖原始色阶。

## 4. 间距规范

| Token        | 当前值 | 建议用途               |
| ------------ | ------ | ---------------------- |
| `--space-0`  | 0      | 显式清零               |
| `--space-1`  | 2px    | 紧邻元素、细微偏移     |
| `--space-2`  | 4px    | 状态堆叠、图文微间距   |
| `--space-3`  | 6px    | 紧凑按钮组、标签间距   |
| `--space-4`  | 8px    | 标准小间距             |
| `--space-5`  | 10px   | 列表内容内边距         |
| `--space-6`  | 12px   | 卡片紧凑内边距         |
| `--space-7`  | 14px   | 次级区块间距           |
| `--space-8`  | 16px   | 标准区块内边距         |
| `--space-9`  | 18px   | 模块间距               |
| `--space-10` | 20px   | 卡片标准内边距         |
| `--space-12` | 24px   | 大区块和上传区域内边距 |

## 5. 圆角、阴影与控件

| 用途           | Token                   | 当前值               |
| -------------- | ----------------------- | -------------------- |
| 小圆角         | `--radius-xs`           | 7px                  |
| 输入和标签圆角 | `--radius-sm`           | 8px                  |
| 列表卡片圆角   | `--radius-md`           | 10px                 |
| 标准卡片圆角   | `--radius-lg`           | 12px                 |
| 大容器圆角     | `--radius-xl`           | 14px                 |
| 胶囊标签       | `--radius-pill`         | 999px                |
| 轻阴影         | `--shadow-sm`           | 卡片悬浮、列表反馈   |
| 中阴影         | `--shadow-md`           | 弹窗、上传符号等浮层 |
| 焦点/选中阴影  | `--shadow-focus`        | 选中卡片和输入焦点   |
| 紧凑控件高度   | `--control-height-sm`   | 34px                 |
| 标准控件高度   | `--control-height-md`   | 36px                 |
| 控件字体       | `--control-font-family` | 与产品默认字体一致   |
| 控件字号       | `--control-font-size`   | 12px                 |
| 控件字重       | `--control-font-weight` | 450                  |
| 控件行高       | `--control-line-height` | 1.6                  |

## 6. 知识库组件规范

| 部位         | Token                             | 目的                     |
| ------------ | --------------------------------- | ------------------------ |
| 左右栏间距   | `--knowledge-layout-gap`          | 保持树与详情的统一留白   |
| 详情卡片间距 | `--knowledge-panel-gap`           | 统一知识库卡片垂直节奏   |
| 左侧最小宽度 | `--knowledge-tree-width-min`      | 防止空间名称被过度压缩   |
| 详情最小宽度 | `--knowledge-content-width-min`   | 保证文档工具栏可读       |
| 空间树行高   | `--knowledge-tree-row-height`     | 统一四类空间和分组密度   |
| 文档行高     | `--knowledge-document-row-height` | 统一文档列表节奏         |
| 页签高度     | `--knowledge-tab-height`          | 统一导航点击区域         |
| 上传区高度   | `--knowledge-drop-zone-height`    | 保持不同入口上传体验一致 |

## 7. 成员录入表单规范

- 基础信息和工作信息使用同级 `fieldset` 分区，不使用“高级”或点击展开入口隐藏字段。个人使用说明书属于员工本人，不放入后台成员录入或管理表单。
- 分区间距使用 `--space-12`，分区内边距使用 `--space-10`，内部字段组使用 `--space-9`。
- 分区边框、背景和标题分别使用 `--color-border-default`、`--color-surface-subtle`、`--color-text-primary`。
- 两列表单在窄屏下统一降为单列，不新增成员页面专用字号、颜色或硬编码间距。

## 8. 变更流程

1. 设计或产品提出视觉调整时，先确认是否已有合适 Token。
2. 已有 Token 能表达：只调整组件对 Token 的引用。
3. 需要全局改变：修改现有 Token，同时检查所有使用方。
4. 需要新语义：在 Token 文件和本文同时登记，再在组件中使用。
5. 执行设计系统测试、管理端类型检查、构建和真实页面视觉复核。

兼容别名 `--ink`、`--muted`、`--line`、`--surface`、`--brand` 等仅用于旧样式渐进迁移。新代码不得继续新增这些别名的使用；后续按页面迁移完成后删除兼容层。

## 9. 知识库目录与批量上传

- 文件夹卡片沿用 `--knowledge-document-row-height`、`--radius-md`、`--color-border-default` 和知识库标准间距，不创建独立字号或颜色。
- 面包屑使用标准正文和 `--color-action-primary`；目录名称与文档名称保持同一信息层级。
- 文件夹上传摘要使用三列紧凑卡片，窄屏降为单列；进度、文件预览以及“被跳过 / 上传失败”结果清单统一使用现有表面色、边框、圆角、字号和间距 Token。失败项重试作为清晰命名的主按钮直接展示，不放入折叠菜单。
- 知识文件夹卡片必须展示递归处理摘要：切片与索引百分比、完成文档数、切片数和异常数。正常进度使用品牌色，存在异常时使用危险色边框、百分比和异常徽标；卡片最小高度使用 `--knowledge-folder-card-min-height`，不得为单个页面硬编码高度。
- “导入文件夹”“新建文件夹”是直接操作按钮，不放入“更多”或“高级”展开入口。
