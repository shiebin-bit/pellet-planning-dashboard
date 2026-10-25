# Millplan 操作说明

## 启动和资料保存

先打开 Docker Desktop，再双击 `OPEN-DASHBOARD.cmd`（或功能相同的 `START-DASHBOARD.cmd`）。两者都会启动 PostgreSQL 数据库版。浏览器地址是 `http://127.0.0.1:8080`。页面左侧显示 PostgreSQL，表示目前使用数据库。第一次启动是空白 planning，可直接新增；示范资料需要在 Settings 主动加载。

双击 `STOP-DASHBOARD.cmd` 停止服务，资料会保留在 Docker volume。不要删除 volume。只有 `OPEN-OFFLINE-DASHBOARD.cmd` 会打开独立的离线版本；资料只在原本浏览器里，和数据库版不共用。

## 界面布局

顶部工具栏集中日期、Today、Export 和 Add production。左侧保留 Overview、Planning board、Data、Stock、History 和 Settings；平板会缩成图标，手机从左上角菜单展开。

Overview 先显示四项总数和当日时间轴，点产品段可查看卡片；四项总数是 Planned volume、Recorded output、Planned utilisation 和 Tasks completed。Recorded output 统计所选排程日期已完成任务的已记录实际产量，并显示覆盖数；不代表该自然日所有入库量。时间轴之后先看 Needs attention 和 Plan vs actual；Line capacity details 与 Next production tasks 可按需展开，停机记录继续保留。Planning board 四条产线横向排列，电脑 1366 × 768 可完整查看；新增、复制、报表和卡片详情在当前页面弹出。

## 日常 planning

1. 在日期选择器直接选日期、月份和年份。
2. 在 Planning board 按 Add production，或产线旁的 +，填写产线、产品、订单、bin 和数量。保存后等待数据库确认。
3. 未开始的卡片可以直接拉到另一条产线。放在另一张卡片上会插入它前面，放在空白处则排在后面。移动后确认新的 bin。Undo 只能撤销最近一次移动，其他修改会使它失效。
4. 点卡片看完整资料。按 Start production 自动记录当前实际开始时间。
5. 完成时按 Mark as done，填写实际 MT 和备注，再按 Confirm done。结束时间由服务器自动记录。

灰色＝未开始；蓝色＝生产中；黄色＝暂停；绿色＝已完成；红色＝有问题。黄色斜线是 changeover。已开始/完成的排程会锁定，避免移动后改掉实际记录。

## 暂停、恢复和停机时间

开始生产后，卡片详情的 **Stops & runtime** 可按 **Pause production**，填写原因后按 **Confirm pause**。暂停时间由服务器记录；卡片变黄色，产线继续由该任务占用，计划时间保持锁定。按 **Resume production** 会记录恢复时间，可重复暂停／恢复。暂停中按 Done 完成，也会同时结束这次暂停。

详情显示累计已记录停机时间、经过时间扣除已记录停机，以及每次暂停的原因和起止时间。Overview 的 **Recorded downtime** 按当前 planning day 统计各线及合计，即使任务属于前一天也会计算实际落在当天的暂停。多条线同时停机按各线时间相加。旧资料没有暂停记录时显示零“已记录停机”，不表示当时完全没停机。

Report a problem 是问题标记；它不会自动暂停。解决问题也不会自动恢复。经过时间扣除停机不能当作真实有效生产时间或 OEE，计划 utilisation 也不会因这个按钮改变。

## 复制 planning

在 Planning board 按 **Copy planning**。默认从前一天复制到当前日期，也可直接修改来源和目标日期。选择产线、勾选卡片，调整数量，并为每张选中卡片填写新的订单编号。取消任务不会列入；订单编号不会沿用旧值。

上方预览显示目标日各线的 MT、计划利用率、结束时间及 Carry-over。确认后整批保存，新卡片排在目标日期同产线最后，状态为未开始；产品、包装、bin 和备注保留，实际时间、实际产量、问题及完成备注清空。原卡片保留。保存失败会保留弹窗草稿；断线时使用 Retry connection，不要重新建立另一批。

## 产品清单

Settings → **Products** 的 **Product catalog** 可搜索、新增、修改及停用／重新启用产品。Code 不分大小写，不能重复；停用产品仍保留在清单里。

新增生产时，在 Product code 输入 code 或名称，再点选匹配产品，系统填写说明。只有新增且尚未输入数量时，才自动套用默认 Bags／Bulk；已输入的数量及旧卡片包装方式会保留。没有匹配项可直接输入新的产品 code，不必先登记清单。修改清单不会改动旧生产记录。

## Overview、History 和报表

Overview 看总量、产线 utilisation、任务状态和需要处理的项目。Utilisation 是排程使用率；实际经过时间包含停机，不能当 OEE。

History 可以同时按日期、产线、状态和关键字筛选。Export 可下载当天 Excel，或选择最多 31 天及指定产线。Excel 新增 Production stops 表，列出原因及时间；当天停机明细只计算该 planning day 内的停机分钟；Actual production 另列整个任务及当天停机时间。日期范围报表列出所选任务的完整暂停。PDF 的任务行显示整个任务资料，当天停机表另外按日界计算。PDF 使用 Print / save as PDF，再在浏览器选择 Save as PDF 和横向。

History 顶部显示全部匹配记录的记录数、完成数、计划 MT（排除取消）以及已记录的实际 MT 和覆盖数。生产记录和活动日志每页 50 条；换筛选或标签会回到第一页。活动日志按自己的关键字及日期统计。新操作会显示 FIELD／BEFORE／AFTER，包含数量、产线、开始／完成、暂停／恢复、产品清单和 Settings 的修改；旧记录保留原来的文字。关键字也能搜索修改前的值。分页只影响画面，报表仍包含所选日期／产线范围的全部记录。

History、Stock 和 Daily stock 在列表上方及下方都能翻页。长表格在列表区域内上下滚动，表头保持可见；窄屏可用 Left／Right 查看其他栏位，右侧操作栏保持可见。换页或筛选会回到表格开头。

顶部 **Planning date** 用于排程及快捷生产报表。History 的日期输入筛选生产日期（Activity log 则筛选操作日期）；Data 的日期筛选交货日期，交期天数按今天的马来西亚日期计算。Stock 的 Snapshot date 是当前台账快照生成日期，台账包含所有已入账变动；Inventory baseline 和 Last verified stock count 分别显示基准和最近盘点日期。Daily stock 使用自己的 **Stock date**。这些范围独立，页面会显示当前日期用途。

Export 的 **Excel report** 和 **Print / save as PDF** 使用顶部 Planning date 及全部四条产线，页面搜索、状态、日期筛选和分页不会套用。菜单会列出该日期；**Date range report** 使用弹窗内选定的日期及产线，也不套用页面搜索／状态。Workspace backup 包含所有日期的资料，数据库版包括订单及库存台账，离线版包含排程、产品清单和 Settings。

Daily stock 的 **Enter physical count** 会立即打开盘点弹窗，载入所选产品、库存日期及 Medication／FMR 组合。填写实盘数量及调整原因，再确认差异；原台账保留。关闭后回到原记录和滚动位置；未保存的表单会关闭，已经确认的盘点不会撤回。断线时保留弹窗并使用 Retry connection 确认同一次调整。

## 断线或同时修改

出现 Saving 时等待确认。若提示保存无法确认，保留表单，恢复 Docker/数据库连接后按 Retry connection。同一个请求会重复确认，避免新增两份任务。

若另一位使用者已修改 planning，系统会显示冲突并保留输入。先检查草稿，再按 Reload latest 载入最新资料，重新填写需要修改的内容后保存。系统不会自动覆盖别人的改动。

## 备份和旧资料迁移

Settings → **Backup & recovery** → Download backup 下载整个 workspace JSON。Restore JSON backup 会先预览，再由 Replace workspace 确认替换；它不会合并资料。替换或数据库版 Reset demo 前的一份 workspace 可以下载恢复，但只保留最近一次。

数据库新版备份为 version 4，包含排产、Data、库存和完整流水；离线版为 version 2，包含排产及产品清单。旧版 version 1 仍能读取，但没有产品清单，恢复后清单为空；预览会明确提醒。恢复前应下载当前备份。

旧离线资料：在原本浏览器、原本 HTML 路径打开 → 下载 JSON → 在数据库版导入。不会自动迁移。

数据库完整备份由 `scripts/backup.ps1` 产生，交接负责人应另外安排定期备份并测试恢复。公司其他电脑连入、权限、登录及 SAP 同步属于之后的部署工作。


## 从 Excel 导入订单（Data）

1. 打开 Data → Import Excel，选择 `.xlsx` 文件（最多 5 MB、2,000 行）。
2. 确认工作表、表头行和 13 个栏位的对应关系。文本日期可选 MM/DD/YYYY、DD/MM/YYYY 或 YYYY/MM/DD；请核对 Excel 实际格式。
3. 填写 Excel as-of date（这些剩余天数是哪一天的数据），默认今天。
4. 预览新增、修改和未变更的订单。错误会显示行号及原因，须全部修正才可保存。勾选确认后整批导入，导入不会自动排产。
5. 在 Data 搜寻 DO、客户、物料或描述，按交期、单位、生产状态、交货状态、逾期或导入批次筛选。每页 50 条，顶部统计包含所有匹配订单。点击 DO 编号会弹出订单详情，关闭后回到原来的列表位置。主列表会按栏宽换行；窄屏可用表格上方的 Left／Right 按钮左右查看，操作栏固定在右侧。
6. 点 DO 查看完整字段、原始天数、来源版本、Medication、FMR / OMED 和导入历史。

DO no + Material code 是订单唯一组合。重复导入相同资料会跳过；修改过的订单保存新版本。后续文件缺少某订单时，原记录仍会保留。编码中的前导零会保留；Excel 数字精度已经丢失的长编码无法恢复，应在 Excel 中用文本保存。公式需先在 Excel 计算并保存结果。

## 从订单排产

Data 的 Plan production 或 Planning board 的 Plan from Data 使用同一个排产弹窗。选单可按 Filters 展开筛选；表格在固定区域内上下及左右滚动，右侧排产按钮固定可见。选择日期、产线、bin 和备注后，把整张订单追加到该线最后。MT 直接作为重量；Bags 按排产时的每袋重量换算，并保留快照。已有卡片的来源订单、物料和数量不能手动覆盖。来源数量修改后会显示 Needs review；尚未开始的卡片可取消后重新排产。取消后允许重新选择订单。Add production 仍可手动新增。

已关联的 Excel 订单不参加 Copy planning，防止同一订单重复生产。不同完整 Material code 会计算换料时间；两张手动卡片沿用原来的前四位产品系列规则。

## 生产、取货和剩余天数

- Start production 直接按服务器当前时间记录。Done 记录生产结束及实际产量；它不会自动确认客户取货。
- Data → Mark delivered 确认取货。有关联卡片时必须先完成生产。没有卡片的外部已生产订单可以确认交货，系统不会虚构生产时间。
- Excel Remark 为 Done 表示已交货、整个流程完成；大小写和前后空格不影响识别。其他文字原样保存。若关联生产仍未结束，则显示 Needs review，保留卡片及实际记录。
- Delivery lead days 是还有几天可以生产。Days of outstanding 是还有几天来取货：3 为剩三天，−2 为逾期两天。
- 从 Excel as-of date 起按马来西亚自然日自动扣减，周末也算；空白保持未知。生产完成后停止生产期限警示，交货后停止取货逾期警示。
- Reopen delivery 必须填写原因。Delivery recorded at 是系统收到确认的时间，不一定是实际取货时间。

## 班次与备份

四条线默认每天 07:00–19:00，超出的生产次日 07:00 继续。Day 显示当班；Full plan 显示跨日分段和夜间不可用时间。改动前的历史待产计划沿用旧班次；已开始、已完成计划和实际时间保留。排产日期不会因队列延后而被改写，请同时查看计算后的开始日期。

数据库 Download backup 生成版本 3，包含排产、Data 订单、导入批次、原始版本及关联。旧版 1/2 仍可恢复，但不含 Data；恢复前会警告，并保留完整的上一份工作区供下载。含 Data 的版本 3 备份必须在数据库版恢复，不能导入离线版后丢弃订单数据。

当前尚未取得实际 SAP Excel 文件；已用截图栏位建立虚构工作簿验证。第一次使用正式文件时，应先核对导入预览和日期/单位，确认后才保存。


## 库存与订单进度

Data 页面专门查看 Orders；左侧独立的 Stock 页面包含 Stock 和 Daily stock 两个标签。两个页面都可按 Import Excel 导入 daily stock 工作簿：订单取自 bag order、bulk order；首次以日期页 Closing 建立库存基准。系统只读数据，不执行宏；Packing bin 汇总不作为可分配库存。

Orders 分开显示订单量、现货预留、累计生产、已取货、仍需生产和已排未入库数量。历史 DONE 表示已备齐，OUT 表示已取走；它们不会再次增加或扣减基准库存。Medication、FMR／OMED 后续由人工维护，SAP 再导入不会覆盖。

每天重复导入按 DO no + 完整 Material code 对应同一张订单，不会累加订单数量或重复入库。例如订单原为 100 袋，Dashboard 已生产并预留 70 袋，SAP 次日仍显示 100 袋，仍按总订单 100 袋计算，缺口为 30 袋。Excel 的数量或交期改变时，确认导入会更新来源资料并保留旧版本；已发生的生产和取货流水、人工 Medication／FMR 及现有排产不会被清空。文件缺少某张订单也不会自动删除或标记 OUT。当前没有按 SAP 导出时间阻挡旧文件的机制，导入旧快照可能把来源数量／交期改回旧值，确认前须核对文件日期和变更预览。库存默认不随重复订单导入覆盖；盘点对账须另行确认差异。

Stock 的 Manage stock 会弹出管理窗口，关闭后保留列表位置；可以在窗口内修改政策或记录库存变动。Stock 可按产品、策略和 Medication／FMR 筛选，修改 25／50kg 袋重、安全库存及固定／百分比超产设置。袋装、散装独立核算。数字安全库存为 Make for stock；PER ADVICE 为 Make for order；空白政策须确认后才自动补库存。安全库存适用于标准版本，药物／FMR 版本按其独立订单排产。

Daily stock 可选日期查看 Opening、Production、Received、Return、Rework、Issue、Adjustment、Closing，并按 Enter physical count 输入盘点数量及原因，预览差异后确认。后续库存 Excel 导入默认只更新订单；如需盘点对账，勾选 Reconcile physical Closing，核对每项差异后确认，不会覆盖原流水。

## 自动排程与分批生产

在 Data 或 Planning board 按 Generate planning，选择日期范围并生成草稿。系统先用兼容现货、扣除已有未完成排程，再按交货日期安排订单缺口，最后补安全库存。四条产线均可用，沿用 07:00–19:00、产能、换料和停机设置。大订单可拆到不同日期／产线，袋数为整数；未排数量会保留。负责人可修改草稿数量、日期和产线，确认后才整批保存，原有卡片不移动。

开始后，在卡片内 Record production quantity 填本次新增产量及日期，可分次入库。Done 填最终累计产量，包括已入账部分，系统只补差额。订单内 Record collection 填本次取货数量；全部取完才 OUT。Stock 的流水可 Correct output 或 Reverse collection，必须填写原因，原记录保留。

数据库备份现为版本 4，包含订单、库存和完整流水。恢复旧版本前会提示不含库存；恢复前会保留完整副本。原有示范卡片不会自动产生真实库存流水。页面的最近盘点日期仅是库存核对边界，之后实际发生的生产、取货及调整仍须录入。

## Settings 标签与卡片预览

Settings 分为 Workspace、Production rules、Unavailable periods、Products、Stock policies（数据库版）及 Backup & recovery。切换这些标签保留输入草稿，页面上方会固定显示 Save settings 和未保存提示。Save settings 只保存工作区、产能及停机列表；产品清单和库存政策各自保存，互不覆盖。如果其他标签有无效栏位，保存会自动打开对应标签并聚焦栏位。离开 Settings 页面仍会丢弃未保存草稿。

排程卡片太窄时，鼠标悬停或用 Tab 聚焦可预览完整产品编号、说明、数量、订单、完整计划起止日期、状态及 bin。Escape 收起预览，Enter／点击打开完整详情；Space 开始键盘移动，方向键移动，Escape 取消移动。触屏继续点击查看详情，长按拖动。
