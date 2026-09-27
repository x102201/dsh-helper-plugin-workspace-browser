/**
 * 页面抽取：`snapshot` 与 `get_text` 的数据来源。
 *
 * ## 为什么分成两半
 *
 * - **页面侧**（`collectPageSnapshot` / `collectPageText`）：用 `Runtime.evaluate` 注入到
 *   标签页里跑，只做**不含判断**的搬运 —— 把元素、属性、文字、矩形原样序列化成 JSON。
 * - **宿主侧**（`buildSnapshotValue` 等）：判定「哪个是可点元素、哪个是表单字段、
 *   哪个值要掩码」，以及编号和排版。
 *
 * 这样切开有两个好处：页面侧注入的代码极小、不依赖任何页面框架；判断逻辑留在宿主，
 * 是纯函数，能用一段固定 HTML 直接测（见 `test/tools.test.mjs`）。
 *
 * ## 页面侧函数必须自包含
 *
 * 注入方式是 `(${fn.toString()})()`，所以这两个函数**不能用模块作用域里的任何东西**
 * —— 没有 import、没有闭包变量、没有常量表。它们只看 `document` / `location` 这两个
 * 全局对象，因此也能在 Node 里用一个假 DOM 直接调用。
 *
 * ## 敏感值掩码发生在宿主侧
 *
 * 页面侧会把 `value` 原样带出来（密码、隐藏字段的 CSRF token 也在内），掩码在宿主侧
 * 做。这不增加暴露面：宿主本来就能读到页面的一切；**关键是模型看到的那份必须是掩码后的**。
 *
 * @module dsh-helper-plugin-workspace-browser/lib/snapshot
 */

/** 掩码占位符。 */
export const MASK_TEXT = '[已掩码]';

/** 正文默认上限（字符）。 */
export const DEFAULT_TEXT_LIMIT = 12000;

/** 可点元素 + 表单字段默认上限。 */
export const DEFAULT_ELEMENT_LIMIT = 200;

/**
 * 页面侧：把「可能是可交互元素」的东西原样搬出来。
 *
 * 粗筛只按标签名/role/tabindex/onclick/contenteditable 判断「值不值得带出去」，
 * 精筛（可点还是表单字段）在宿主侧。这样注入的代码里没有业务判断。
 *
 * ⚠️ 函数体里**不能引用模块作用域的任何东西**（上限常量、正则、Set 都不行）：
 * 它会被 `toString()` 之后单独注入页面。`test/tools.test.mjs` 里有一条测试专门
 * 盯着这件事。
 *
 * @returns {string} JSON 字符串。
 */
export function collectPageSnapshot() {
  /** 页面侧元素数量上限。 */
  var PAGE_ELEMENT_LIMIT = 1500;
  /** 页面侧抓正文的上限，防止超长页面把 JSON 撑爆。 */
  var PAGE_TEXT_LIMIT = 200000;
  var INTERESTING_TAGS = {
    A: 1,
    BUTTON: 1,
    INPUT: 1,
    SELECT: 1,
    TEXTAREA: 1,
    SUMMARY: 1,
    LABEL: 1,
    OPTION: 1,
    DETAILS: 1,
  };
  var ATTR_NAMES = [
    'id',
    'name',
    'type',
    'href',
    'role',
    'aria-label',
    'aria-expanded',
    'placeholder',
    'autocomplete',
    'alt',
    'title',
    'tabindex',
    'for',
    'contenteditable',
    'onclick',
    'data-testid',
    'maxlength',
    'pattern',
    'hidden',
    'aria-hidden',
  ];
  var BOOL_ATTRS = ['checked', 'disabled', 'selected', 'multiple', 'readonly', 'required'];

  function textOf(element) {
    var raw = '';
    try {
      raw = element.innerText || element.textContent || '';
    } catch (error) {
      raw = '';
    }
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function rectOf(element) {
    try {
      var rect = element.getBoundingClientRect();
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    } catch (error) {
      return { w: 0, h: 0 };
    }
  }

  function attrsOf(element) {
    var attrs = {};
    var index;
    for (index = 0; index < ATTR_NAMES.length; index += 1) {
      var name = ATTR_NAMES[index];
      var value = null;
      try {
        value = element.getAttribute(name);
      } catch (error) {
        value = null;
      }
      if (value !== null && value !== undefined && value !== '') attrs[name] = String(value).slice(0, 300);
    }
    for (index = 0; index < BOOL_ATTRS.length; index += 1) {
      var boolName = BOOL_ATTRS[index];
      var boolValue = null;
      try {
        boolValue = element[boolName];
      } catch (error) {
        boolValue = null;
      }
      if (boolValue === true) attrs[boolName] = 'true';
      else if (boolValue === false) attrs[boolName] = 'false';
    }
    // 输入框的当前值只有属性/属性反射都不一定拿得到（用户改过之后），单独取一次。
    var tag = String(element.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      try {
        if (typeof element.value === 'string') attrs.value = element.value.slice(0, 300);
      } catch (error) {
        // 某些元素读 value 会抛（例如自定义元素），忽略。
      }
    }
    return attrs;
  }

  function selectorOf(element) {
    try {
      if (element.id) return '#' + String(element.id).replace(/([^\w-])/g, '\\$1');
      var parts = [];
      var node = element;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 4) {
        var tag = String(node.tagName || '').toLowerCase();
        var name = node.getAttribute ? node.getAttribute('name') : null;
        if (name) {
          parts.unshift(tag + '[name="' + String(name).replace(/"/g, '\\"') + '"]');
          break;
        }
        var parent = node.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        var siblings = parent.children || [];
        var sameTag = 0;
        var position = 1;
        for (var i = 0; i < siblings.length; i += 1) {
          if (siblings[i].tagName === node.tagName) {
            sameTag += 1;
            if (siblings[i] === node) position = sameTag;
          }
        }
        parts.unshift(sameTag > 1 ? tag + ':nth-of-type(' + position + ')' : tag);
        node = parent;
        depth += 1;
      }
      return parts.join(' > ');
    } catch (error) {
      return '';
    }
  }

  var elements = [];
  var truncated = false;
  var nodes = [];
  try {
    nodes = document.querySelectorAll('*');
  } catch (error) {
    nodes = [];
  }

  for (var index = 0; index < nodes.length; index += 1) {
    if (elements.length >= PAGE_ELEMENT_LIMIT) {
      truncated = true;
      break;
    }
    var element = nodes[index];
    var tag = String(element.tagName || '').toUpperCase();
    var attrs = attrsOf(element);
    var interesting =
      INTERESTING_TAGS[tag] === 1 ||
      attrs.role !== undefined ||
      attrs.tabindex !== undefined ||
      attrs.onclick !== undefined ||
      attrs.contenteditable !== undefined;
    if (!interesting) continue;
    elements.push({
      tag: tag,
      attrs: attrs,
      text: textOf(element),
      rect: rectOf(element),
      selector: selectorOf(element),
    });
  }

  var bodyText = '';
  try {
    bodyText = document.body ? document.body.innerText || document.body.textContent || '' : '';
  } catch (error) {
    bodyText = '';
  }
  bodyText = String(bodyText);
  if (bodyText.length > PAGE_TEXT_LIMIT) bodyText = bodyText.slice(0, PAGE_TEXT_LIMIT);

  return JSON.stringify({
    title: document.title || '',
    url: location.href || '',
    text: bodyText,
    elements: elements,
    truncated: truncated,
  });
}

/**
 * 页面侧：取一块区域的文字。
 *
 * @param {string} selector - CSS 选择器；空串表示整个 `body`。
 * @returns {string} JSON 字符串。
 */
export function collectPageText(selector) {
  var element = null;
  try {
    element = selector ? document.querySelector(selector) : document.body;
  } catch (error) {
    return JSON.stringify({
      found: false,
      invalidSelector: true,
      message: '选择器无效：' + String((error && error.message) || error),
    });
  }
  if (!element) {
    return JSON.stringify({
      found: false,
      invalidSelector: false,
      message: selector ? '没有匹配 ' + selector + ' 的元素' : '页面没有 body',
    });
  }
  var text = '';
  try {
    text = element.innerText || element.textContent || '';
  } catch (error) {
    text = '';
  }
  text = String(text);
  return JSON.stringify({
    found: true,
    title: document.title || '',
    url: location.href || '',
    text: text.slice(0, 200000),
  });
}

/** 输入框里属于「按钮」而不是「字段」的类型。 */
const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image']);

/** 按 role 判定为可点的角色。 */
const CLICKABLE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'option',
  'treeitem',
  'checkbox',
  'radio',
]);

/** 明显是敏感字段的类型。 */
const SENSITIVE_TYPES = new Set(['password', 'hidden']);

/** 名字里带这些词的字段，值一律掩码。 */
const SENSITIVE_NAME_RE = /(pass(word|wd)?|secret|token|otp|one[-_]?time|auth|credential|cvv|cvc|card[-_]?number|ssn|api[-_]?key|session[-_]?id)/iu;

/** `autocomplete` 里带这些词的字段，值一律掩码。 */
const SENSITIVE_AUTOCOMPLETE_RE = /(password|one-time-code|cc-number|cc-csc|cc-exp)/iu;

/**
 * 读字符串属性。
 *
 * @param {object} attrs - 属性表。
 * @param {string} name - 属性名。
 * @returns {string} 值；没有时为空串。
 */
function attr(attrs, name) {
  const value = attrs?.[name];
  return typeof value === 'string' ? value : '';
}

/**
 * 元素是否可见（有面积）。
 *
 * @param {object} element - 页面侧搬出来的元素。
 * @returns {boolean} 可见为 true。
 */
function isVisible(element) {
  const rect = element?.rect;
  if (rect === null || typeof rect !== 'object') return false;
  return Number(rect.w) > 0 && Number(rect.h) > 0;
}

/**
 * 是不是「值要掩码」的字段。
 *
 * @param {object} field - 整理后的字段。
 * @returns {boolean} 要掩码为 true。
 */
export function isSensitiveField(field) {
  if (SENSITIVE_TYPES.has(field.fieldType)) return true;
  if (SENSITIVE_AUTOCOMPLETE_RE.test(field.autocomplete ?? '')) return true;
  return SENSITIVE_NAME_RE.test(`${field.name ?? ''} ${field.fieldId ?? ''} ${field.label ?? ''}`);
}

/**
 * 把页面侧搬出来的元素整理成给模型看的快照值。
 *
 * @param {object} raw - `collectPageSnapshot()` 解析后的对象。
 * @param {object} [options] - 参数。
 * @param {number} [options.textLimit] - 正文字符上限。
 * @param {number} [options.elementLimit] - 元素条数上限。
 * @returns {object} 快照值（不含工具信封）。
 */
export function buildSnapshotValue(raw, options = {}) {
  const textLimit = Number.isSafeInteger(options.textLimit) && options.textLimit > 0 ? options.textLimit : DEFAULT_TEXT_LIMIT;
  const elementLimit =
    Number.isSafeInteger(options.elementLimit) && options.elementLimit > 0 ? options.elementLimit : DEFAULT_ELEMENT_LIMIT;

  const elements = Array.isArray(raw?.elements) ? raw.elements : [];
  const fullText = typeof raw?.text === 'string' ? raw.text : '';

  // 先收集 `<label for=…>`：字段的可读名字优先用它。
  const labelByFor = new Map();
  for (const element of elements) {
    if (element?.tag !== 'LABEL') continue;
    const target = attr(element.attrs, 'for');
    const label = typeof element.text === 'string' ? element.text.trim() : '';
    if (target !== '' && label !== '' && !labelByFor.has(target)) labelByFor.set(target, label);
  }

  const clickables = [];
  const fields = [];
  let index = 0;
  let truncated = raw?.truncated === true;

  for (const element of elements) {
    if (clickables.length + fields.length >= elementLimit) {
      truncated = true;
      break;
    }
    if (element === null || typeof element !== 'object') continue;
    const tag = typeof element.tag === 'string' ? element.tag : '';
    const attrs = element.attrs ?? {};
    const fieldType = fieldKindOf(tag, attrs);
    const visible = isVisible(element);
    // 隐藏字段没有面积，但它正是要报告成「有值但已掩码」的东西。
    if (!visible && !(fieldType !== null && attr(attrs, 'type').toLowerCase() === 'hidden')) continue;
    if (attr(attrs, 'hidden') === 'true' || attr(attrs, 'aria-hidden') === 'true') continue;

    if (fieldType !== null) {
      index += 1;
      const fieldId = attr(attrs, 'id');
      const label =
        attr(attrs, 'aria-label') ||
        (fieldId !== '' ? labelByFor.get(fieldId) ?? '' : '') ||
        attr(attrs, 'placeholder') ||
        attr(attrs, 'title');
      const name = attr(attrs, 'name');
      // 掩码判断只有一处（`isSensitiveField`），模型看到的那份一定和测试断言的一致。
      const masked = isSensitiveField({
        fieldType,
        name,
        fieldId,
        label,
        autocomplete: attr(attrs, 'autocomplete'),
      });
      const field = {
        index,
        kind: 'field',
        tag: tag.toLowerCase(),
        fieldType,
        name,
        fieldId,
        label,
        selector: typeof element.selector === 'string' ? element.selector : '',
        disabled: attr(attrs, 'disabled') === 'true',
        masked,
        value: masked ? MASK_TEXT : attr(attrs, 'value'),
      };
      if (fieldType === 'checkbox' || fieldType === 'radio') {
        field.checked = attr(attrs, 'checked') === 'true';
      }
      fields.push(field);
      continue;
    }

    const clickable = clickableSummary(element, tag, attrs);
    if (clickable === null) continue;
    index += 1;
    clickables.push({ index, kind: 'clickable', ...clickable });
  }

  return {
    title: typeof raw?.title === 'string' ? raw.title : '',
    url: typeof raw?.url === 'string' ? raw.url : '',
    text: fullText.length > textLimit ? fullText.slice(0, textLimit) : fullText,
    textTruncated: fullText.length > textLimit,
    clickables,
    fields,
    elementsTruncated: truncated,
  };
}

/**
 * 判定元素的字段类型；不是表单字段返回 null。
 *
 * @param {string} tag - 大写标签名。
 * @param {object} attrs - 属性表。
 * @returns {string | null} 字段类型。
 */
function fieldKindOf(tag, attrs) {
  const type = attr(attrs, 'type').toLowerCase();
  if (tag === 'TEXTAREA') return 'textarea';
  if (tag === 'SELECT') return attr(attrs, 'multiple') === 'true' ? 'select-multiple' : 'select';
  if (tag === 'OPTION') return null;
  if (tag !== 'INPUT') return null;
  if (BUTTON_INPUT_TYPES.has(type)) return null;
  return type === '' ? 'text' : type;
}

/**
 * 把一个元素整理成可点条目；不是可点元素返回 null。
 *
 * @param {object} element - 页面侧搬出来的元素。
 * @param {string} tag - 大写标签名。
 * @param {object} attrs - 属性表。
 * @returns {{ tag: string, text: string, href: string, selector: string, disabled: boolean, via: string } | null} 条目。
 */
function clickableSummary(element, tag, attrs) {
  const role = attr(attrs, 'role').toLowerCase();
  const text = typeof element.text === 'string' ? element.text.trim() : '';
  const href = attr(attrs, 'href');
  const onclick = attr(attrs, 'onclick');
  const tabindex = attr(attrs, 'tabindex');

  let via = '';
  if (tag === 'A') via = 'a';
  else if (tag === 'BUTTON') via = 'button';
  else if (tag === 'SUMMARY') via = 'summary';
  else if (tag === 'INPUT' && BUTTON_INPUT_TYPES.has(attr(attrs, 'type').toLowerCase())) via = 'input-button';
  else if (CLICKABLE_ROLES.has(role)) via = `role=${role}`;
  else if (onclick !== '') via = 'onclick';
  else if (tabindex !== '' && Number.parseInt(tabindex, 10) >= 0) via = 'tabindex';
  // `label` 刻意不算可点元素：它的文字已经作为字段名出现，重复列出只是噪声。
  if (via === '') return null;

  // `aria-label` 优先：图标按钮的文字往往是 `×` 这种符号，它的可读名字在 aria-label 里。
  const label = attr(attrs, 'aria-label') || text || attr(attrs, 'alt') || attr(attrs, 'title') || attr(attrs, 'value');
  return {
    tag: tag.toLowerCase(),
    text: label.slice(0, 120),
    href: href.slice(0, 300),
    selector: typeof element.selector === 'string' ? element.selector : '',
    disabled: attr(attrs, 'disabled') === 'true',
    via,
  };
}

/**
 * 把快照值排成给模型看的文本（不含 `<UNTRUSTED_PAGE_CONTENT>` 包裹，那由 lib/tools.js 加）。
 *
 * @param {object} value - `buildSnapshotValue()` 的结果。
 * @returns {string} 文本。
 */
export function renderSnapshotText(value) {
  const lines = [];
  lines.push(`标题：${value.title === '' ? '(无)' : value.title}`);
  lines.push(`网址：${value.url === '' ? '(无)' : value.url}`);

  lines.push('');
  lines.push(`正文${value.textTruncated ? '（已截断）' : ''}：`);
  lines.push(value.text === '' ? '(无可见文字)' : value.text);

  lines.push('');
  lines.push(`可点元素（${value.clickables.length} 个，用 [编号] 指代）：`);
  if (value.clickables.length === 0) lines.push('(没有)');
  for (const item of value.clickables) {
    const parts = [`[${item.index}]`, `<${item.tag}>`, `"${item.text === '' ? '(无文字)' : item.text}"`];
    if (item.href !== '') parts.push(`→ ${item.href}`);
    parts.push(`(${item.via}${item.disabled ? '，禁用' : ''})`);
    lines.push(parts.join(' '));
  }

  lines.push('');
  lines.push(`表单字段（${value.fields.length} 个，敏感值已掩码）：`);
  if (value.fields.length === 0) lines.push('(没有)');
  for (const field of value.fields) {
    const parts = [`[${field.index}]`, `<${field.tag} type=${field.fieldType}>`];
    if (field.label !== '') parts.push(`标签="${field.label}"`);
    if (field.name !== '') parts.push(`name="${field.name}"`);
    if (field.fieldId !== '') parts.push(`id="${field.fieldId}"`);
    if (field.masked) parts.push(`值=${MASK_TEXT}`);
    else if (field.value !== '') parts.push(`值="${field.value}"`);
    if (typeof field.checked === 'boolean') parts.push(field.checked ? '已勾选' : '未勾选');
    if (field.disabled) parts.push('禁用');
    lines.push(parts.join(' '));
  }

  if (value.elementsTruncated) lines.push('（元素太多，清单已截断）');
  return lines.join('\n');
}

/**
 * 把 `get_text` 的结果排成给模型看的文本。
 *
 * @param {object} value - 结果。
 * @returns {string} 文本。
 */
export function renderTextValue(value) {
  const lines = [];
  if (value.selector !== '') lines.push(`选择器：${value.selector}`);
  lines.push(`标题：${value.title === '' ? '(无)' : value.title}`);
  lines.push(`网址：${value.url === '' ? '(无)' : value.url}`);
  lines.push('');
  lines.push(value.textTruncated ? '区域文字（已截断）：' : '区域文字：');
  lines.push(value.text === '' ? '(无可见文字)' : value.text);
  return lines.join('\n');
}
