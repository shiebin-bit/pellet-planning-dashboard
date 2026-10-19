# Millplan 操作说明

## 启动和资料保存

先打开 Docker Desktop，再双击 `OPEN-DASHBOARD.cmd`（或功能相同的 `START-DASHBOARD.cmd`）。两者都会启动 PostgreSQL 数据库版。浏览器地址是 `http://127.0.0.1:8080`。页面左侧显示 PostgreSQL，表示目前使用数据库。第一次启动是空白 planning，可直接新增；示范资料需要在 Settings 主动加载。

双击 `STOP-DASHBOARD.cmd` 停止服务，资料会保留在 Docker volume。不要删除 volume。只有 `OPEN-OFFLINE-DASHBOARD.cmd` 会打开独立的离线版本；资料只在原本浏览器里，和数据库版不共用。

## 日常 planning

1. 在日期选择器直接选日期、月份和年份。
2. 在 Planning board 按 Add production，或产线旁的 +，填写产线、产品、订单、bin 和数量。保存后等待数据库确认。
3. 未开始的卡片可以直接拉到另一条产线。放在另一张卡片上会插入它前面，放在空白处则排在后面。移动后确认新的 bin。Undo 只能撤销最近一次移动，其他修改会使它失效。
4. 点卡片看完整资料。实际开始时间手动填写，再按 Start production。
5. 完成时按 Mark as done，填写实际 MT 和备注，再按 Confirm done。结束时间由服务器自动记录。

灰色＝未开始；蓝色＝生产中；绿色＝已完成；红色＝有问题。黄色斜线是 changeover。已开始/完成的排程会锁定，避免移动后改掉实际记录。

## Overview、History 和报表

Overview 看总量、产线 utilisation、任务状态和需要处理的项目。Utilisation 是排程使用率；实际经过时间包含停机，不能当 OEE。

History 可以同时按日期、产线、状态和关键字筛选。Export 可下载当天 Excel，或选择最多 31 天及指定产线。PDF 使用 Print / save as PDF，再在浏览器选择 Save as PDF 和横向。

## 断线或同时修改

出现 Saving 时等待确认。若提示保存无法确认，保留表单，恢复 Docker/数据库连接后按 Retry connection。同一个请求会重复确认，避免新增两份任务。

若另一位使用者已修改 planning，系统会显示冲突并保留输入。先检查草稿，再按 Reload latest 载入最新资料，重新填写需要修改的内容后保存。系统不会自动覆盖别人的改动。

## 备份和旧资料迁移

Settings → Download backup 下载整个 workspace JSON。Restore JSON backup 会先预览，再由 Replace workspace 确认替换；它不会合并资料。替换或数据库版 Reset demo 前的一份 workspace 可以下载恢复，但只保留最近一次。

旧离线资料：在原本浏览器、原本 HTML 路径打开 → 下载 JSON → 在数据库版导入。不会自动迁移。

数据库完整备份由 `scripts/backup.ps1` 产生，交接负责人应另外安排定期备份并测试恢复。公司其他电脑连入、权限、登录及 SAP 同步属于之后的部署工作。
