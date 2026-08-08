// 旅游攻略协作应用 —— 多语言支持 (zh/en)
// v=20260806c

const I18N = {
  _lang: localStorage.getItem('travel_lang') || 'zh',
  _dict: {
    zh: {
      appTitle: '旅行攻略协作',
      overview: '概览',
      plan: '行程',
      nav: '导航',
      expense: '费用',
      review: '审阅',
      settings: '设置',
      login: '登录',
      logout: '退出',
      joinRoom: '加入房间',
      createRoom: '创建房间',
      myRooms: '我的房间',
      addItem: '添加行程',
      addExpense: '记一笔',
      edit: '编',
      delete: '删',
      save: '保存',
      cancel: '取消',
      confirm: '确认',
      close: '关闭',
      all: '全部',
      keep: '保留',
      merge: '合并',
      drop: '删除',
      batchKeep: '批量保留',
      batchDrop: '批量删除',
      selectAll: '全选',
      share: '分享',
      exportPDF: '导出PDF',
      search: '搜索行程…',
      budget: '预算',
      noBudget: '未设定',
      remaining: '剩余',
      overspent: '超支',
      todaySchedule: '今日行程',
      tomorrowSchedule: '明日行程',
      weather: '天气',
      rainAlert: '今日有雨，记得带伞 ☔',
      hotAlert: '今日高温，注意防暑 🥵',
      coldAlert: '今日温差较大，注意保暖 🧥',
      sunnyAlert: '天气晴好，适合出行 ☀️',
      sync: '同步',
      justSync: '刚刚同步',
      syncing: '同步中…',
      offline: '网络异常',
      offlineHint: '网络连接失败，数据可能不是最新的',
      retry: '重试',
      noItems: '还没有行程，先在上方添加吧',
      noExpenses: '还没有费用记录',
      noReview: '暂无行程可审阅',
      expenseSummary: '费用总览',
      totalSpent: '总支出',
      perPerson: '人均',
      expenseCategories: {
        '餐饮': '餐饮',
        '交通': '交通',
        '门票': '门票',
        '住宿': '住宿',
        '购物': '购物',
        '其他': '其他'
      },
      itemTypes: {
        '景点': '景点',
        '餐饮': '餐饮',
        '住宿': '住宿',
        '交通': '交通',
        '门票': '门票',
        '购物': '购物',
        '其他': '其他'
      },
      statusLabels: {
        'proposed': '待审阅',
        'kept': '已保留',
        'merged': '已合并',
        'dropped': '已删除'
      },
      splitEqual: '均分',
      splitCustom: '自定义',
      receiptUpload: '拍照 / 选照片',
      receiptRemove: '移除收据',
      receiptTag: '收据',
      payer: '付款人',
      currency: '币种',
      amount: '金额',
      description: '描述',
      linkItem: '关联行程',
      date: '日期',
      time: '时间',
      place: '地点',
      note: '备注',
      creator: '创建人',
      people: '同行人',
      editPeople: '编辑同行人',
      online: '在线',
      roomId: '房间号',
      adminPanel: '管理后台',
      roomMgmt: '房间管理',
      userMgmt: '用户管理',
      auditLog: '日志审计',
      toast: {
        itemAdded: '行程已添加',
        itemUpdated: '行程已更新',
        itemDeleted: '行程已删除',
        itemMerged: '行程已合并',
        expenseAdded: '费用已记录',
        expenseUpdated: '费用已更新',
        expenseDeleted: '费用已删除',
        budgetSettingsSaved: '预算已保存',
        roomCreated: '房间已创建',
        settingsSaved: '设置已保存',
        backupDone: '数据已导出',
        remindersOn: '行程提醒已开启',
        remindersOff: '行程提醒已关闭'
      },
      prompt: {
        loginFirst: '请先登录',
        permissionDenied: '权限不足',
        guestWarning: '你当前是游客身份，请先登录账号。',
        confirmDelete: '确认删除',
        confirmDeleteItem: '确定要删除这条行程吗？',
        confirmDeleteExpense: '确定要删除这笔费用吗？',
        setBudget: '设定预算',
        budgetHint: '请输入旅行总预算',
        aliasHint: '请输入4位数字房间号',
        roomNameHint: '请输入房间名称'
      }
    },
    en: {
      appTitle: 'Travel Planner',
      overview: 'Overview',
      plan: 'Plan',
      nav: 'Nav',
      expense: 'Expense',
      review: 'Review',
      settings: 'Settings',
      login: 'Login',
      logout: 'Logout',
      joinRoom: 'Join Room',
      createRoom: 'Create Room',
      myRooms: 'My Rooms',
      addItem: 'Add Item',
      addExpense: 'Add Expense',
      edit: 'Edit',
      delete: 'Del',
      save: 'Save',
      cancel: 'Cancel',
      confirm: 'Confirm',
      close: 'Close',
      all: 'All',
      keep: 'Keep',
      merge: 'Merge',
      drop: 'Drop',
      batchKeep: 'Batch Keep',
      batchDrop: 'Batch Drop',
      selectAll: 'Select All',
      share: 'Share',
      exportPDF: 'Export PDF',
      search: 'Search plans…',
      budget: 'Budget',
      noBudget: 'Not set',
      remaining: 'Remaining',
      overspent: 'Overspent',
      todaySchedule: "Today's Plan",
      tomorrowSchedule: "Tomorrow's Plan",
      weather: 'Weather',
      rainAlert: 'Rain today, bring an umbrella ☔',
      hotAlert: 'High temperature, stay hydrated 🥵',
      coldAlert: 'Big temperature swing, dress warmly 🧥',
      sunnyAlert: 'Nice weather, great for going out ☀️',
      sync: 'Sync',
      justSync: 'Just synced',
      syncing: 'Syncing…',
      offline: 'Offline',
      offlineHint: 'Network error, data may not be up to date',
      retry: 'Retry',
      noItems: 'No plans yet. Add one above!',
      noExpenses: 'No expenses recorded',
      noReview: 'No items to review',
      expenseSummary: 'Expense Summary',
      totalSpent: 'Total Spent',
      perPerson: 'Per Person',
      expenseCategories: {
        '餐饮': 'Dining',
        '交通': 'Transport',
        '门票': 'Tickets',
        '住宿': 'Lodging',
        '购物': 'Shopping',
        '其他': 'Other'
      },
      itemTypes: {
        '景点': 'Sight',
        '餐饮': 'Dining',
        '住宿': 'Lodging',
        '交通': 'Transport',
        '门票': 'Tickets',
        '购物': 'Shopping',
        '其他': 'Other'
      },
      statusLabels: {
        'proposed': 'Pending',
        'kept': 'Kept',
        'merged': 'Merged',
        'dropped': 'Dropped'
      },
      splitEqual: 'Equal',
      splitCustom: 'Custom',
      receiptUpload: 'Take Photo / Choose',
      receiptRemove: 'Remove Receipt',
      receiptTag: 'Receipt',
      payer: 'Payer',
      currency: 'Currency',
      amount: 'Amount',
      description: 'Description',
      linkItem: 'Linked Item',
      date: 'Date',
      time: 'Time',
      place: 'Place',
      note: 'Note',
      creator: 'Creator',
      people: 'Travelers',
      editPeople: 'Edit Travelers',
      online: 'Online',
      roomId: 'Room ID',
      adminPanel: 'Admin Panel',
      roomMgmt: 'Room Mgmt',
      userMgmt: 'User Mgmt',
      auditLog: 'Audit Log',
      toast: {
        itemAdded: 'Item added',
        itemUpdated: 'Item updated',
        itemDeleted: 'Item deleted',
        itemMerged: 'Item merged',
        expenseAdded: 'Expense recorded',
        expenseUpdated: 'Expense updated',
        expenseDeleted: 'Expense deleted',
        budgetSettingsSaved: 'Budget saved',
        roomCreated: 'Room created',
        settingsSaved: 'Settings saved',
        backupDone: 'Data exported',
        remindersOn: 'Reminders enabled',
        remindersOff: 'Reminders disabled'
      },
      prompt: {
        loginFirst: 'Please Login First',
        permissionDenied: 'Permission Denied',
        guestWarning: 'You are browsing as a guest. Please login first.',
        confirmDelete: 'Confirm Delete',
        confirmDeleteItem: 'Are you sure you want to delete this item?',
        confirmDeleteExpense: 'Are you sure you want to delete this expense?',
        setBudget: 'Set Budget',
        budgetHint: 'Enter total trip budget',
        aliasHint: 'Enter 4-digit room code',
        roomNameHint: 'Enter room name'
      }
    }
  },

  t(key) {
    const keys = key.split('.');
    let val = this._dict[this._lang];
    for (const k of keys) {
      if (val == null) break;
      val = val[k];
    }
    return val ?? key;
  },

  setLang(lang) {
    this._lang = lang;
    localStorage.setItem('travel_lang', lang);
  },

  getLang() { return this._lang; }
};

// 全局快捷
function t(key) { return I18N.t(key); }
function setLang(lang) {
  I18N.setLang(lang);
  if (window.render) window.render();
  updateLangButton();
}

function updateLangButton() {
  const btn = document.getElementById('btnLang');
  if (!btn) return;
  btn.textContent = I18N._lang === 'zh' ? 'EN' : '中';
}
