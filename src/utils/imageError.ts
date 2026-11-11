export function imageErrorMessage(error: unknown) {
  const message = String(error);
  if (/no such file|not found|cannot find|os error [23]\b|系统找不到|文件不存在/i.test(message)) return "原文件无法访问";
  if (/unsupported|not supported|decoder|decode|格式不支持|无法解码/i.test(message)) return "图片格式无法解码";
  return "图片加载失败";
}
