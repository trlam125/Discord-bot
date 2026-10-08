/**
 * Keep Discord channel notifications brief. Diagnostics stay in service logs,
 * never in messages where they could reveal source URLs, paths or providers.
 */
const USER_ACTION_ERRORS = new Set([
  'Bạn cần vào phòng thoại trước khi /play',
  'Bot đang ở phòng thoại khác',
  'Hàng đợi đã đủ 20 bài',
  'Bot chưa phát nhạc trong server này',
  'Bạn cần ở cùng phòng thoại với bot để điều khiển',
  'Không thể tạm dừng hiện tại',
  'Không có bài đang tạm dừng',
  'Không có bài đang phát'
]);

export function publicVoiceError(error) {
  const message = error?.message;
  return USER_ACTION_ERRORS.has(message)
    ? message
    : 'Không thể xử lý yêu cầu. Vui lòng thử lại.';
}

export function voiceQueueSummary(session) {
  const count = session.queue.length;
  return session.current
    ? `Đang phát nhạc. Hàng đợi: ${count} bài.`
    : `Chưa có bài đang phát. Hàng đợi: ${count} bài.`;
}
