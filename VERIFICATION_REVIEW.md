# مراجعة صفحة طلبات التوثيق — فرع تجريبي

الفرع: `feature/verification-review`

يحتوي هذا الفرع على:
- `functions/api/verifications.js`
- `verifications.js`
- `verifications.css`

## ربط الصفحة في index.html

التعديلات المطلوبة لتظهر الصفحة في الواجهة:

1. بعد `<link rel="stylesheet" href="./styles.css">` أضف:
```html
<link rel="stylesheet" href="./verifications.css">
```

2. في القائمة الجانبية، بعد زر إدارة المستخدمين أضف:
```html
<button class="nav-item" data-page="verifications"><span>✓</span> طلبات التوثيق</button>
```

3. قبل قسم `settings-page` أضف:
```html
<section id="verifications-page" class="page hidden">
  <div class="section-heading">
    <div><h2>طلبات التوثيق</h2><p>مراجعة الهوية والسيلفي واتخاذ القرار. للمالك فقط، وكل عرض لصورة يُسجّل في سجل التدقيق.</p></div>
    <button id="refresh-verifications" class="secondary-button" type="button">تحديث</button>
  </div>
  <div class="panel users-panel">
    <div class="users-toolbar">
      <select id="verifications-filter" aria-label="تصفية الطلبات">
        <option value="pending">قيد المراجعة</option><option value="approved">الموثّقة</option>
        <option value="rejected">المرفوضة</option><option value="all">الكل</option>
      </select>
    </div>
    <p id="verifications-status" class="helper" role="status">اضغط تحديث لعرض الطلبات.</p>
    <div class="users-table-wrap"><table class="users-table">
      <thead><tr><th>المستخدم</th><th>الهاتف</th><th>تاريخ الطلب</th><th>الحالة</th><th>إجراء</th></tr></thead>
      <tbody id="verifications-table-body"></tbody>
    </table></div>
  </div>
</section>
```

4. قبل `<footer>` أضف نافذة المراجعة:
```html
<div id="verification-review-modal" class="user-details-modal hidden" role="dialog" aria-modal="true" aria-labelledby="verification-review-title" aria-hidden="true">
  <div class="user-details-card vr-card">
    <div class="user-details-heading"><h2 id="verification-review-title">مراجعة طلب توثيق</h2></div>
    <div id="verification-review-body"></div>
    <div class="user-details-footer"><button id="close-verification-review" class="secondary-button" type="button">إغلاق</button></div>
  </div>
</div>
```

5. بعد `<script src="./app.js?v=5"></script>` أضف:
```html
<script src="./verifications.js?v=1"></script>
```

6. في `app.js` أضف إلى `AUDIT_LABELS`:
```js
admin_decide_verification: "قرار في طلب توثيق",
admin_view_verification_file: "عرض صورة توثيق"
```

## تنبيه
هذه الصفحة لن تظهر قبل إدخال عناصر HTML أعلاه. لا تنشر اللوحة قبل مراجعة صلاحيات المالك، والتأكد من إعداد أسرار Cloudflare، واختبار طلبات القراءة والقرار. لم تُطبّق أي Migration على قاعدة البيانات.
