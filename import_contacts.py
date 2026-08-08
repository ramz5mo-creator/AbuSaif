#!/usr/bin/env python3
"""
مطابقة جهات الاتصال من Google Contacts مع ورقة المسجلين
وتحديث الأسماء الفارغة في عمود B
"""
import csv
import json
import re
import sys
import os
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# إعدادات
SPREADSHEET_ID = '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0'
CONTACTS_FILE = '/home/ubuntu/upload/pasted_file_V1wXgY_contacts(1).csv'
TOKEN_FILE = '/home/ubuntu/AbuSaif/token.json'
CREDS_FILE = '/home/ubuntu/AbuSaif/oauth-credentials.json'

def clean_phone(phone):
    """تنظيف رقم الهاتف وإزالة مفتاح الدولة"""
    if not phone:
        return None
    # إزالة كل شيء ما عدا الأرقام
    digits = re.sub(r'[^\d]', '', phone)
    if not digits:
        return None
    # إزالة مفتاح الدولة 962
    if digits.startswith('962') and len(digits) > 9:
        digits = digits[3:]
    # إزالة الصفر البادئ
    if digits.startswith('0') and len(digits) > 8:
        digits = digits[1:]
    # يجب أن يكون 9 أرقام على الأقل
    if len(digits) < 7:
        return None
    return digits

def load_contacts(csv_file):
    """تحميل جهات الاتصال من CSV وبناء خريطة رقم → اسم"""
    phone_to_name = {}
    with open(csv_file, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            first = row.get('First Name', '').strip()
            last = row.get('Last Name', '').strip()
            name = (first + ' ' + last).strip()
            # تنظيف الاسم من الرموز الزائدة
            name = re.sub(r'^["\'.،\s]+|["\'.،\s]+$', '', name)
            if not name:
                continue
            # جمع كل الأرقام
            for key in ['Phone 1 - Value', 'Phone 2 - Value', 'Phone 3 - Value']:
                raw_phone = row.get(key, '').strip()
                if raw_phone:
                    cleaned = clean_phone(raw_phone)
                    if cleaned and cleaned not in phone_to_name:
                        phone_to_name[cleaned] = name
    return phone_to_name

def get_sheets_service():
    """الحصول على خدمة Google Sheets"""
    import json
    token_data = json.load(open(TOKEN_FILE))
    creds_data = json.load(open(CREDS_FILE))
    client_info = creds_data.get('installed') or creds_data.get('web', {})
    # دمج بيانات العميل مع التوكن
    merged = {
        'client_id': client_info['client_id'],
        'client_secret': client_info['client_secret'],
        'token_uri': client_info.get('token_uri', 'https://oauth2.googleapis.com/token'),
        'access_token': token_data['access_token'],
        'refresh_token': token_data['refresh_token'],
        'scopes': token_data.get('scope', '').split(),
    }
    creds = Credentials(
        token=merged['access_token'],
        refresh_token=merged['refresh_token'],
        token_uri=merged['token_uri'],
        client_id=merged['client_id'],
        client_secret=merged['client_secret'],
        scopes=merged['scopes']
    )
    service = build('sheets', 'v4', credentials=creds)
    return service

def main():
    print("📂 تحميل جهات الاتصال من CSV...")
    contacts_map = load_contacts(CONTACTS_FILE)
    print(f"✅ تم تحميل {len(contacts_map)} رقم فريد من جهات الاتصال")

    print("\n📊 قراءة ورقة المسجلين...")
    service = get_sheets_service()
    sheet = service.spreadsheets()

    # قراءة ورقة المسجلين (A:D)
    result = sheet.values().get(
        spreadsheetId=SPREADSHEET_ID,
        range='المسجلين!A:D'
    ).execute()
    rows = result.get('values', [])
    print(f"✅ تم قراءة {len(rows)} صف من ورقة المسجلين")

    # تحليل الصفوف وإيجاد الأسماء المفقودة
    updates = []
    matched = 0
    already_named = 0
    not_found = 0

    for i, row in enumerate(rows):
        if i == 0:  # تخطي الرأس إذا وجد
            if row and row[0] in ['الهاتف', 'Phone', 'رقم الهاتف', 'A']:
                continue

        phone_raw = row[0].strip() if len(row) > 0 else ''
        current_name = row[1].strip() if len(row) > 1 else ''

        if not phone_raw:
            continue

        cleaned = clean_phone(phone_raw)
        if not cleaned:
            continue

        # إذا كان الاسم موجوداً بالفعل → تخطي
        if current_name:
            already_named += 1
            continue

        # البحث في جهات الاتصال
        contact_name = contacts_map.get(cleaned)
        if contact_name:
            row_num = i + 1  # Google Sheets 1-indexed
            updates.append({
                'range': f'المسجلين!B{row_num}',
                'values': [[contact_name]]
            })
            matched += 1
            print(f"  ✅ {phone_raw} ({cleaned}) → {contact_name}")
        else:
            not_found += 1

    print(f"\n📊 النتائج:")
    print(f"  - أسماء موجودة مسبقاً: {already_named}")
    print(f"  - أسماء ستُضاف: {matched}")
    print(f"  - لم يُعثر عليها في جهات الاتصال: {not_found}")

    if not updates:
        print("\n✅ لا توجد أسماء فارغة تحتاج تحديثاً!")
        return

    print(f"\n💾 تحديث {len(updates)} اسم في ورقة المسجلين...")

    # تحديث دفعي
    batch_size = 100
    total_updated = 0
    for i in range(0, len(updates), batch_size):
        batch = updates[i:i+batch_size]
        body = {'valueInputOption': 'RAW', 'data': batch}
        service.spreadsheets().values().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body=body
        ).execute()
        total_updated += len(batch)
        print(f"  ✅ تم تحديث {total_updated}/{len(updates)}")

    print(f"\n🎉 تم! تم إضافة {total_updated} اسم جديد في ورقة المسجلين")

if __name__ == '__main__':
    main()
