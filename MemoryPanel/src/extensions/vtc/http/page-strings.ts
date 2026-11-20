export type PageLang = 'en' | 'vi' | 'zh-CN';
export type PageKind =
  | 'error'
  | 'waiting'
  | 'refused'
  | 'device_confirm'
  | 'device_done'
  | 'device_waiting'
  | 'device_refused'
  | 'device_expired';
export type ErrorCode =
  | 'state_mismatch'
  | 'sso_failed'
  | 'expired'
  | 'replayed'
  | 'unreadable'
  | 'unavailable'
  | 'wrong_instance'
  | 'key_limit'
  | 'busy'
  | 'bad_request';

export interface PageStrings {
  htmlLang: string;
  logout: string;
  backToLogin: string;
  account: string;
  status: string;
  pending: string;
  requested: string;
  waitingTitle: string;
  waitingText: string;
  refusedTitle: string;
  refusedText: string;
  errorTitle: string;
  errors: Record<ErrorCode, string>;
  deviceTitle: string;
  deviceLead: (deviceName: string) => string;
  deviceCode: string;
  deviceCheck: string;
  deviceLogin: string;
  deviceNote: string;
  deviceDoneTitle: string;
  deviceDone: string;
  deviceWaitingTitle: string;
  deviceWaiting: string;
  deviceRefusedTitle: string;
  deviceRefused: string;
  deviceExpiredTitle: string;
  deviceExpired: string;
}

export const PAGE_STRINGS: Record<PageLang, PageStrings> = {
  en: {
    htmlLang: 'en',
    logout: 'Log out',
    backToLogin: 'Back to login',
    account: 'Account',
    status: 'Status',
    pending: 'Pending',
    requested: 'Requested',
    waitingTitle: 'Your account is waiting for an admin to add you to a team',
    waitingText:
      'You logged in with VTC Mail. An admin must add you to a team before you can use Memory Hub. You do not need to do anything now.',
    refusedTitle: 'Your request was not approved',
    refusedText:
      'An admin rejected the request for this account. Ask your team lead if you think this is a mistake.',
    errorTitle: 'Login did not complete',
    errors: {
      state_mismatch: 'This login did not start on this page. Start again.',
      sso_failed: 'VTC Mail did not confirm the login. Start again.',
      expired: 'The login link expired. Start again.',
      replayed: 'This login link was already used. Start again.',
      unreadable: 'The login reply could not be read. Start again.',
      unavailable: 'The service is not available now. Try again in a few minutes.',
      wrong_instance: 'VTC Mail login is not available for this memory instance.',
      key_limit: 'This account has too many active keys. Ask an admin to remove old keys on the API Keys page.',
      busy: 'Too many logins are in progress. Try again in a minute.',
      bad_request: 'This login request is not valid. Start again.',
    },
    deviceTitle: 'Connect a device',
    deviceLead: (name) => `${name} wants to connect to Memory Hub with your account.`,
    deviceCode: 'Code',
    deviceCheck: 'Make sure this code matches the one in Paseo.',
    deviceLogin: 'Log in with VTC Mail',
    deviceNote: 'You will log in on inside.vtcmobile.vn. Memory Hub never sees your password.',
    deviceDoneTitle: 'Device connected',
    deviceDone: 'Device connected. You can close this page and return to Paseo.',
    deviceWaitingTitle: 'Waiting for an admin',
    deviceWaiting:
      'You are logged in, but an admin must add you to a team first. Paseo connects by itself after that.',
    deviceRefusedTitle: 'Your request was not approved',
    deviceRefused: 'An admin rejected the request for this account.',
    deviceExpiredTitle: 'Code expired',
    deviceExpired: 'This code expired or is not valid. Start the login again in Paseo.',
  },
  vi: {
    htmlLang: 'vi',
    logout: 'Đăng xuất',
    backToLogin: 'Quay lại đăng nhập',
    account: 'Tài khoản',
    status: 'Trạng thái',
    pending: 'Chờ duyệt',
    requested: 'Yêu cầu lúc',
    waitingTitle: 'Tài khoản của bạn đang chờ admin thêm vào team',
    waitingText:
      'Bạn đã đăng nhập bằng mail VTC. Admin cần thêm bạn vào một team trước khi bạn dùng được Memory Hub. Bạn không cần làm gì lúc này.',
    refusedTitle: 'Yêu cầu của bạn chưa được duyệt',
    refusedText:
      'Admin đã từ chối yêu cầu cho tài khoản này. Hãy hỏi trưởng nhóm nếu bạn cho rằng đây là nhầm lẫn.',
    errorTitle: 'Đăng nhập chưa hoàn tất',
    errors: {
      state_mismatch: 'Lần đăng nhập này không bắt đầu từ trang này. Hãy bắt đầu lại.',
      sso_failed: 'Mail VTC không xác nhận đăng nhập. Hãy bắt đầu lại.',
      expired: 'Đường dẫn đăng nhập đã hết hạn. Hãy bắt đầu lại.',
      replayed: 'Đường dẫn đăng nhập này đã được dùng. Hãy bắt đầu lại.',
      unreadable: 'Không đọc được phản hồi đăng nhập. Hãy bắt đầu lại.',
      unavailable: 'Dịch vụ hiện chưa sẵn sàng. Hãy thử lại sau vài phút.',
      wrong_instance: 'Đăng nhập bằng mail VTC không dùng được cho memory instance này.',
      key_limit: 'Tài khoản này có quá nhiều key đang hoạt động. Hãy nhờ admin xóa key cũ ở trang API Keys.',
      busy: 'Đang có quá nhiều lượt đăng nhập. Hãy thử lại sau một phút.',
      bad_request: 'Yêu cầu đăng nhập không hợp lệ. Hãy bắt đầu lại.',
    },
    deviceTitle: 'Kết nối thiết bị',
    deviceLead: (name) => `${name} muốn kết nối Memory Hub bằng tài khoản của bạn.`,
    deviceCode: 'Mã',
    deviceCheck: 'Kiểm tra mã này trùng với mã trong Paseo.',
    deviceLogin: 'Đăng nhập bằng mail VTC',
    deviceNote: 'Bạn đăng nhập trên inside.vtcmobile.vn. Memory Hub không bao giờ thấy mật khẩu của bạn.',
    deviceDoneTitle: 'Đã kết nối thiết bị',
    deviceDone: 'Đã kết nối thiết bị. Bạn có thể đóng trang này và quay lại Paseo.',
    deviceWaitingTitle: 'Đang chờ admin',
    deviceWaiting:
      'Bạn đã đăng nhập, nhưng admin cần thêm bạn vào một team trước. Sau đó Paseo sẽ tự kết nối.',
    deviceRefusedTitle: 'Yêu cầu của bạn chưa được duyệt',
    deviceRefused: 'Admin đã từ chối yêu cầu cho tài khoản này.',
    deviceExpiredTitle: 'Mã đã hết hạn',
    deviceExpired: 'Mã này đã hết hạn hoặc không hợp lệ. Hãy bắt đầu đăng nhập lại trong Paseo.',
  },
  'zh-CN': {
    htmlLang: 'zh-CN',
    logout: '退出登录',
    backToLogin: '返回登录',
    account: '账号',
    status: '状态',
    pending: '待审批',
    requested: '申请时间',
    waitingTitle: '您的账号正在等待管理员将您加入团队',
    waitingText: '您已通过 VTC 邮箱登录。管理员需要先把您加入某个团队，您才能使用 Memory Hub。您现在无需任何操作。',
    refusedTitle: '您的申请未获批准',
    refusedText: '管理员已拒绝该账号的申请。如果您认为这是误判，请联系您的团队负责人。',
    errorTitle: '登录未完成',
    errors: {
      state_mismatch: '此次登录不是从本页面发起的，请重新开始。',
      sso_failed: 'VTC 邮箱未确认此次登录，请重新开始。',
      expired: '登录链接已过期，请重新开始。',
      replayed: '此登录链接已被使用，请重新开始。',
      unreadable: '无法读取登录回复，请重新开始。',
      unavailable: '服务暂时不可用，请几分钟后重试。',
      wrong_instance: '此记忆实例不支持 VTC 邮箱登录。',
      key_limit: '该账号的有效密钥过多。请让管理员在 API Keys 页面删除旧密钥。',
      busy: '正在进行的登录过多，请一分钟后重试。',
      bad_request: '此登录请求无效，请重新开始。',
    },
    deviceTitle: '连接设备',
    deviceLead: (name) => `${name} 想用您的账号连接 Memory Hub。`,
    deviceCode: '代码',
    deviceCheck: '请确认此代码与 Paseo 中显示的一致。',
    deviceLogin: '使用 VTC 邮箱登录',
    deviceNote: '您将在 inside.vtcmobile.vn 上登录。Memory Hub 不会看到您的密码。',
    deviceDoneTitle: '设备已连接',
    deviceDone: '设备已连接。您可以关闭此页面并返回 Paseo。',
    deviceWaitingTitle: '等待管理员',
    deviceWaiting: '您已登录，但管理员需要先把您加入某个团队。之后 Paseo 会自动连接。',
    deviceRefusedTitle: '您的申请未获批准',
    deviceRefused: '管理员已拒绝该账号的申请。',
    deviceExpiredTitle: '代码已过期',
    deviceExpired: '此代码已过期或无效。请在 Paseo 中重新开始登录。',
  },
};

/** First supported language by q-order: vi*, zh* or en*. Anything else is skipped; the default is English. */
export function pickLang(acceptLanguage: string | undefined): PageLang {
  if (!acceptLanguage) return 'en';
  const entries = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)).find(Boolean);
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q[1]) : 1, index };
    })
    .filter((entry) => entry.tag && Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of entries) {
    if (tag.startsWith('vi')) return 'vi';
    if (tag.startsWith('zh')) return 'zh-CN';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}
