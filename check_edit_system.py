#!/usr/bin/env python3
"""فحص نظام التعديل - التحقق من سجل الحركات وسجل التعديلات"""

import json
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# تحميل بيانات المصادقة
with open('/home/ubuntu/AbuSaif/token.json') as f:
    token_data = json.load(f)

with open('/home/ubuntu/AbuSaif/oauth-credentials.json') as f:
    creds_data = json.load(f)

web = creds_data.get('web', creds_data.get('installed', {}))
creds = Credentials(
    token=token_data.get('access_token'),
    refresh_token=token_data.get('refresh_token'),
    token_uri='https://oauth2.googleapis.com/token',
    client_id=web.get('client_id'),
    client_secret=web.get('client_secret'),
    scopes=token_data.get('scope', '').split()
)

service = build('sheets', 'v4', credentials=creds)
SPREADSHEET_ID = '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0'

# 1. فحص سجل الحركات
print("=" * 60)
print("📋 سجل الحركات - آخر 10 صفوف:")
print("=" * 60)
try:
    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range="'سجل الحركات'!A:J"
    ).execute()
    rows = result.get('values', [])
    print(f"إجمالي الصفوف: {len(rows)}")
    if rows:
        print(f"الرؤوس: {rows[0]}")
        print(f"\nآخر 10 صفوف:")
        for i, row in enumerate(rows[-10:], len(rows)-9):
            print(f"  [{i}] {row}")
except Exception as e:
    print(f"خطأ: {e}")

# 2. فحص سجل التعديلات
print("\n" + "=" * 60)
print("✏️ سجل التعديلات:")
print("=" * 60)
try:
    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range="'سجل التعديلات'!A:H"
    ).execute()
    rows = result.get('values', [])
    print(f"إجمالي الصفوف: {len(rows)}")
    for row in rows[:20]:
        print(f"  {row}")
except Exception as e:
    print(f"خطأ (ربما الورقة غير موجودة): {e}")

# 3. فحص ورقة الإعدادات للمشرفين
print("\n" + "=" * 60)
print("⚙️ الإعدادات - المشرفين:")
print("=" * 60)
try:
    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range="'الإعدادات'!A:B"
    ).execute()
    rows = result.get('values', [])
    for row in rows:
        if 'مشرف' in str(row):
            print(f"  {row}")
except Exception as e:
    print(f"خطأ: {e}")

print("\n✅ انتهى الفحص")
