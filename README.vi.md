# @vocweb/opencode-advisor

Plugin cho [opencode](https://opencode.ai) thêm một model thứ hai để theo dõi session của bạn. Nó đọc những gì agent chính đang làm và gửi lời khuyên ngay khi agent còn đang chạy. Đây là bản port của advisor (watchdog) trong oh-my-pi. English: [README.md](README.md).

Sau mỗi bước của agent chính, advisor chỉ đọc phần mới của transcript, trong một session con ẩn của riêng nó. Nó chỉ lên tiếng khi thấy vấn đề thật, qua tool `advise` mà agent chính không nhìn thấy.

## Cài đặt

Plugin này cần opencode 1.19.x. Nó chưa nạp được trên opencode 2.x, vì bản 2.x yêu cầu định dạng plugin khác (một default export có `id`) và báo lỗi "Plugin must export a default definition". Kiểm tra phiên bản bằng `opencode --version`.

Thêm package vào `opencode.json`, file global `~/.config/opencode/opencode.json` hoặc file trong project:

```json
{ "plugin": ["@vocweb/opencode-advisor"] }
```

opencode tự cài khi khởi động. Lần chạy đầu tiên, plugin tạo file `~/.config/opencode/WATCHDOG.yml` ban đầu (chưa có model) và hiện một toast nhắc bạn. Sau đó chọn model ngay trong opencode:

```
/advisor setup anthropic/claude-haiku-4-5
```

Lệnh này lưu model và có hiệu lực ngay, không cần khởi động lại. Khi chưa đặt model, advisor không làm gì và không ảnh hưởng đến agent chính. Gõ `/advisor` để xem trạng thái.

Muốn plugin không tạo file ban đầu, đặt `OPENCODE_ADVISOR_NO_SETUP=1`. Cài thủ công từ mã nguồn: `npm install && npm run build && scripts/install.sh [--project]`.

## Cách hoạt động

| Phần | Mô tả |
|---|---|
| Đọc phần mới | Mỗi lần review chỉ gửi các tin nhắn mới. Advisor giữ ngữ cảnh riêng trong session con có tiêu đề `[advisor] ...`. |
| Tool `advise` | Nhận `note` và `severity`: `nit`, `concern` hoặc `blocker`. Chỉ advisor được dùng. |
| Định tuyến | `nit` đi kèm lần gọi LLM kế tiếp và không được lưu. `concern` thấy giữa chừng thì chờ đến khi agent dừng. `blocker`, hoặc `concern` ở cuối lượt, được chèn vào lượt đang chạy hoặc đánh thức agent đang rảnh. Sau câu trả lời cuối, chỉ note từ mức `continueSeverity` trở lên mới đánh thức agent, mức thấp hơn thành thẻ. Nếu bạn vừa bấm Esc, đã chạm trần steer hoặc đang ở plan mode thì note chỉ hiện thành thẻ và agent không bị chạy lại. Note của nhiều advisor đến cùng lúc được gộp thành một tin nhắn và chỉ đánh thức tối đa một lần. |
| Emission guard | Bỏ note rỗng ("LGTM"), note trùng và note vượt ngân sách. `immuneTurns` tạo khoảng nghỉ sau mỗi lần steer, `maxSteersPerPrompt` chặn advisor và agent qua lại mãi. |
| An toàn | Output của advisor không đáng tin. Note giống prompt injection, hoặc gợi ý lệnh phá hoại (`rm -rf`, `curl \| sh`, force-push) không có trong transcript, sẽ bị từ chối. Bị từ chối hai lần liên tiếp thì ngữ cảnh của advisor được reset. |
| Quyền | Advisor có `advise` cùng `read`, `grep`, `glob` (cấu hình được). Các file bí mật phổ biến như `.env`, khóa, credentials bị từ chối. Mọi quyền khác đều bị từ chối. |
| Xử lý lỗi | Review lỗi được thử lại ba lần với backoff rồi bỏ batch. Sau `maxConsecutiveFailures` batch bị bỏ, advisor dừng; agent chính không bị ảnh hưởng. Có `retry.fallbackChains` thì model lỗi được thay bằng model kế tiếp. Nếu mọi model đều chạm giới hạn sử dụng, advisor tạm dừng ở trạng thái `quota_paused` và giữ lại batch. `/advisor reset` gỡ cả hai trạng thái. Nén session chính sẽ reset advisor, và ngữ cảnh advisor quá lớn sẽ được dựng lại. |

## Lệnh `/advisor`

| Lệnh | Tác dụng |
|---|---|
| `/advisor` | Bật hoặc tắt advisor cho session này |
| `on` / `off` | Giống trên nhưng nói rõ. `off` hủy các review đang chạy và không đụng đến session khác. `on` chỉ review những gì xảy ra sau đó |
| `status` | Mỗi advisor một dòng: trạng thái (`idle`, `reviewing`, `paused`, `inactive/no_model`, `halted`, `quota_paused`), model đang dùng, nhãn `fallback`, context tokens, tổng token, chi phí, notes n/c/b, số note bị lọc và bị hoãn. Kèm cờ của session và các cảnh báo cấu hình |
| `dump` / `dump raw` | Transcript riêng của advisor: các update, câu trả lời và lệnh `[advise severity] note`. `raw` thêm system prompt, danh sách tool, reasoning và mọi tool call. Trả về dạng text, không copy vào clipboard |
| `configure` | Vị trí các file `WATCHDOG.yml` của project và user, có tồn tại hay không, mọi cảnh báo validate, từng entry trong roster và trạng thái của nó |
| `configure init [project\|user]` | Tạo file mẫu có chú thích (mặc định `project`). Không bao giờ ghi đè |
| `enable <name>` / `disable <name>` | Sửa `enabled` của entry trong file chứa nó, giữ nguyên comment, và áp dụng ngay |
| `setup <provider/model[:level]>` | Ghi `modelRoles.advisor` vào `WATCHDOG.yml` của user, giữ nguyên comment. Có hiệu lực ngay |
| `reset` | Bắt đầu ngữ cảnh advisor mới và gỡ `halted`, `quota_paused` |
| `pause` / `resume` / `inbox` | Tạm giữ review, tiếp tục review, hoặc liệt kê các note đã giao |

Trong oh-my-pi, `/advisor configure` là một TUI editor. Ở đây nó in ra text, và bạn đổi cấu hình bằng `enable`, `disable`, `setup`. Các thay đổi khác (tools, instructions, nhịp review, retry) cần khởi động lại opencode.

## Cấu hình: `WATCHDOG.yml`

Schema giống của oh-my-pi. Các file được đọc từ cũ đến mới, file sau thắng: `~/.config/opencode/WATCHDOG.yml` và `.yaml`, rồi với mỗi thư mục từ gốc repo xuống project, `<dir>/WATCHDOG.yml`, `.yaml`, `<dir>/.opencode/WATCHDOG.yml` và `.yaml`. Các entry trong roster được gộp theo slug của tên, còn `instructions` ở cấp cao nhất được nối lại theo thứ tự đọc. File YAML sai cú pháp bị bỏ qua kèm cảnh báo. Một entry roster hỏng không ảnh hưởng các entry khác.

`OPENCODE_ADVISOR=off` tắt plugin, `OPENCODE_ADVISOR=1` ép bật. File mẫu đầy đủ ở [`WATCHDOG.example.yml`](WATCHDOG.example.yml), hoặc chạy `/advisor configure init`.

```yaml
instructions: |            # chung cho mọi advisor; "@./file.md" được mở rộng
  Prefer small, concrete findings.
modelRoles:
  advisor: anthropic/claude-haiku-4-5   # model mặc định; "inherit" = model của agent chính
advisor:
  reviewMode: turn         # turn | agent-end (chỉ cho advisor mặc định)
  reviewInterval: 1        # (chỉ cho advisor mặc định)
  syncBacklog: off         # off | 1 | 3 | 5 | strict
  continueSeverity: concern
retry:
  fallbackChains:
    advisor: [google/gemini-3-pro]
task:
  agentAdvisor: { task: on }
advisors:
  - name: Security
    model: anthropic/claude-sonnet-4-5
    tools: [read, grep]
    reviewMode: agent-end
    reviewInterval: 2
    instructions: |
      Focus on secrets and injection.
```

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `advisor.enabled` | true | Công tắc chính. oh-my-pi mặc định false, nhưng ở đây cài plugin đã có nghĩa là bạn muốn dùng |
| `modelRoles.advisor` | không | Model mặc định cho advisor không có `model` riêng |
| `maxNotesPerUpdate` | 4 | Từ 1 đến 32. Thứ tự ưu tiên: theo advisor, cấp cao nhất, `advisor.maxNotesPerUpdate`, rồi 4 |
| `advisor.reviewMode`, `reviewInterval` | `turn`, 1 | `turn` review mỗi N bước; `agent-end` review mỗi N lần agent dừng. Chỉ áp dụng cho advisor mặc định. Entry trong roster tự đặt, mặc định là `turn` và 1 |
| `advisor.syncBacklog`, `syncBacklog` của entry | off | Bắt agent chính chờ advisor trước lần gọi LLM kế tiếp khi hàng đợi đạt N review (`1`, `3`, `5`). `strict` chờ không giới hạn, các mức còn lại bỏ chờ sau 30 giây. Abort, lỗi hoặc pause sẽ kết thúc việc chờ |
| `advisor.immuneTurns` | 3 | Sau một lần steer, các concern về sau thành aside trong N lượt. Blocker không bị ảnh hưởng |
| `advisor.continueSeverity` | concern | Sau câu trả lời cuối, note từ mức này trở lên đánh thức agent. Mức thấp hơn thành thẻ |
| `advisor.evictStaleResults` | true | Output cũ của `read`, `grep`, `glob` trong ngữ cảnh advisor được thay bằng một dòng giữ chỗ ngắn |
| `retry.*` | xem file mẫu | `enabled`, `modelFallback`, `fallbackOn` (`any`, `usage-limit`, `except-usage-limit`), `fallbackRevertPolicy` (`cooldown-expiry`, `never`), `maxDelayMs` (thời gian nghỉ của model lỗi), `fallbackChains` (khóa `advisor`, `provider/model`, `provider/*`; khóa cụ thể nhất thắng) |
| `task.agentAdvisor` | không | Ánh xạ tên subagent sang `on`, `off` hoặc `provider/model`. Định nghĩa agent cũng có thể đặt `advisor: true` hoặc `advisor: "provider/model"` |
| `advisors[]` | một advisor mặc định | `name`, `enabled`, `model`, `tools`, `reviewMode`, `reviewInterval`, `syncBacklog`, `maxNotesPerUpdate`, `instructions` |
| `advisor.*` riêng của plugin | | `maxSteersPerPrompt` (6), `contextTokenBudget` (120000), `reviewTimeoutMs` (300000), `maxConsecutiveFailures` (3, tính theo số batch bị bỏ), `toast`, `explainToPrimary`, `includeReasoning`, `fetchLimit`, `primeMessages`, `primeChars`, `maxMessageChars`, `maxToolInputChars`, `maxToolOutputChars`, `maxEditChars`, `controlModel` |

Tên tool theo oh-my-pi: `search` là `grep`, `find` là `glob`, còn `write` và `ast_edit` là `edit`. Tên không có tương đương trong opencode (`recall`, `eval`, `debug`...) bị bỏ kèm cảnh báo. Nếu danh sách có phần tử nhưng không cái nào hợp lệ, nó quay về `read, grep, glob`. `tools: []` nghĩa là không có tool điều tra nào.

Một số tùy chọn của oh-my-pi không có tương đương trong opencode. Chúng được chấp nhận nhưng bị bỏ qua kèm cảnh báo: `tier.advisor`, fallback theo mức sử dụng (`retry.usageAwareFallback`, `usageReserve*`, `waitForUsageReset`), xoay vòng credential, evict signed-reasoning, tích hợp Agent Hub, RPC và ACP, TUI editor, và copy clipboard. Hậu tố `:level` của model được phân tích nhưng bị bỏ qua, vì prompt của SDK opencode không có trường mức suy luận.

`WATCHDOG.md`, đặt trong project hoặc `~/.config/opencode/`, chỉ chứa hướng dẫn dành cho advisor. File hỗ trợ import `@./file.md`.

## Quyền riêng tư và chi phí

- Nội dung transcript, gồm cả output của tool và các file advisor đọc, được gửi đến nhà cung cấp model của advisor. Các dạng secret phổ biến (khóa API, JWT, khối PEM, thông tin đăng nhập trong URL) được che khỏi transcript. Output của các lần `read` do chính advisor gọi thì không được che, và secret nằm trong file có tên lạ cũng không bị chặn. Hãy chọn nhà cung cấp bạn tin tưởng, hoặc đặt `tools: []`.
- Ở chế độ `turn`, model advisor được gọi sau mỗi bước, nên chi phí tăng nhanh trong các session dài. Hãy dùng model rẻ, `reviewMode: agent-end`, hoặc `reviewInterval` lớn hơn.
- `/advisor` tốn một lần gọi model rất nhỏ, vì opencode luôn chạy model cho mỗi command. Câu trả lời thật được thay vào trong một hook.

## Giới hạn đã biết

- Thay đổi cấu hình ngoài `/advisor setup`, `enable` và `disable` cần khởi động lại opencode.
- `syncBacklog` chỉ giữ được agent chính trước lần gọi LLM kế tiếp, không giữ được trước khi nó trả câu trả lời cuối. Với `agent-end` và `strict`, review chạy sau câu trả lời cuối, rồi note từ mức `continueSeverity` trở lên mới đánh thức agent.
- Khi thoát, plugin chờ tối đa 15 giây cho các review đang chạy, nhưng opencode 1.19.3 không await `dispose` của plugin. Với `opencode run`, tiến trình thoát khoảng 15 ms sau khi `dispose` bắt đầu, nên review cuối của lần chạy headless bị mất. `opencode serve` nhận SIGTERM thì không gọi `dispose`.
- Plugin được viết cho API plugin của opencode 1.19.x và dùng các hook `experimental.*` có thể thay đổi. Toast TUI chưa được kiểm thử tự động. Phần còn lại được kiểm thử với `opencode serve` thật.
- Agent tự định nghĩa với `"*": "allow"` sẽ thấy tool `advise`. Các lần gọi của nó bị từ chối.

## Phát triển

```bash
npm install
npm run check      # typecheck, unit test, build
npm run test:e2e   # cần binary opencode: OPENCODE_BIN=/đường/dẫn/opencode
npm run test:pack  # cài tarball đã đóng gói qua opencode.json và chạy một review
```

Bộ E2E chạy `opencode serve` thật trong sandbox cô lập, nối tới một mock tương thích OpenAI có kịch bản, nên advisor và agent cư xử giống nhau ở mọi lần chạy. Dùng opencode 1.19.x cho phần này, vì bản 2.x có API khác.

## Tác giả

Tien ([chutien@gmail.com](mailto:chutien@gmail.com), [github.com/vocweb](https://github.com/vocweb))

## Giấy phép

MIT
