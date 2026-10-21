# Millplan 操作说明

## 启动和资料保存

先打开 Docker Desktop，再双击 `OPEN-DASHBOARD.cmd`（或功能相同的 `START-DASHBOARD.cmd`）。两者都会启动 PostgreSQL 数据库版。浏览器地址是 `http://127.0.0.1:8080`。页面左侧显示 PostgreSQL，表示目前使用数据库。第一次启动是空白 planning，可直接新增；示范资料需要在 Settings 主动加载。

双击 `STOP-DASHBOARD.cmd` 停止服务，资料会保留在 Docker volume。不要删除 volume。只有 `OPEN-OFFLINE-DASHBOARD.cmd` 会打开独立的离线版本；资料只在原本浏览器里，和数据库版不共用。

## 界面布局

顶部工具栏集中日期、Today、Export 和 Add production。左侧保留 Overview、Planning board、History 和 Settings；平板会缩成图标，手机从左上角菜单展开。

Overview 先显示四项总数和当日时间轴，点产品段可查看卡片；下方 Line capacity 集中每条线的 MT、任务数、利用率、生产／空闲时间和跨日情况。Needs attention、实际产量、停机时间和待生产任务继续保留。Planning board 四条产线横向排列，电脑 1366 × 768 可完整查看；新增、复制、报表和卡片详情在当前页面弹出。

## 日常 planning

1. 在日期选择器直接选日期、月份和年份。
2. 在 Planning board 按 Add production，或产线旁的 +，填写产线、产品、订单、bin 和数量。保存后等待数据库确认。
3. 未开始的卡片可以直接拉到另一条产线。放在另一张卡片上会插入它前面，放在空白处则排在后面。移动后确认新的 bin。Undo 只能撤销最近一次移动，其他修改会使它失效。
4. 点卡片看完整资料。实际开始时间手动填写，再按 Start production。
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

Settings 下方的 **Product catalog** 可搜索、新增、修改及停用／重新启用产品。Code 不分大小写，不能重复；停用产品仍保留在清单里。

新增生产时，在 Product code 输入 code 或名称，再点选匹配产品，系统填写说明。只有新增且尚未输入数量时，才自动套用默认 Bags／Bulk；已输入的数量及旧卡片包装方式会保留。没有匹配项可直接输入新的产品 code，不必先登记清单。修改清单不会改动旧生产记录。

## Overview、History 和报表

Overview 看总量、产线 utilisation、任务状态和需要处理的项目。Utilisation 是排程使用率；实际经过时间包含停机，不能当 OEE。

History 可以同时按日期、产线、状态和关键字筛选。Export 可下载当天 Excel，或选择最多 31 天及指定产线。Excel 新增 Production stops 表，列出原因及时间；当天停机明细只计算该 planning day 内的停机分钟；Actual production 另列整个任务及当天停机时间。日期范围报表列出所选任务的完整暂停。PDF 的任务行显示整个任务资料，当天停机表另外按日界计算。PDF 使用 Print / save as PDF，再在浏览器选择 Save as PDF 和横向。

History 顶部显示全部匹配记录的记录数、完成数、计划 MT（排除取消）以及已记录的实际 MT 和覆盖数。生产记录和活动日志每页 50 条；换筛选或标签会回到第一页。活动日志按自己的关键字及日期统计。新操作会显示 FIELD／BEFORE／AFTER，包含数量、产线、开始／完成、暂停／恢复、产品清单和 Settings 的修改；旧记录保留原来的文字。关键字也能搜索修改前的值。分页只影响画面，报表仍包含所选日期／产线范围的全部记录。

## 断线或同时修改

出现 Saving 时等待确认。若提示保存无法确认，保留表单，恢复 Docker/数据库连接后按 Retry connection。同一个请求会重复确认，避免新增两份任务。

若另一位使用者已修改 planning，系统会显示冲突并保留输入。先检查草稿，再按 Reload latest 载入最新资料，重新填写需要修改的内容后保存。系统不会自动覆盖别人的改动。

## 备份和旧资料迁移

Settings → Download backup 下载整个 workspace JSON。Restore JSON backup 会先预览，再由 Replace workspace 确认替换；它不会合并资料。替换或数据库版 Reset demo 前的一份 workspace 可以下载恢复，但只保留最近一次。

新版备份为 version 2，包含产品清单。旧版 version 1 仍能读取，但没有产品清单，恢复后清单为空；预览会明确提醒。恢复前应下载当前备份。

旧离线资料：在原本浏览器、原本 HTML 路径打开 → 下载 JSON → 在数据库版导入。不会自动迁移。

数据库完整备份由 `scripts/backup.ps1` 产生，交接负责人应另外安排定期备份并测试恢复。公司其他电脑连入、权限、登录及 SAP 同步属于之后的部署工作。
