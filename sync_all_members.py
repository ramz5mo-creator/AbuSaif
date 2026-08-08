#!/usr/bin/env python3
"""
مزامنة شاملة: استخراج جميع الأرقام من الأوراق اليومية والأرشيف
ومقارنتها مع ورقة المسجلين وإضافة الناقصين مع أسمائهم من Google Contacts
"""
import csv
import json
import re
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SPREADSHEET_ID = '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0'
CONTACTS_FILE = '/home/ubuntu/upload/pasted_file_V1wXgY_contacts(1).csv'
TOKEN_FILE = '/home/ubuntu/AbuSaif/token.json'
CREDS_FILE = '/home/ubuntu/AbuSaif/oauth-credentials.json'

def clean_phone(phone):
    """تنظيف رقم الهاتف"""
    if not phone:
        return None
    digits = re.sub(r'[^\d]', '', str(phone))
    if not digits:
        return None
    if digits.startswith('962') and len(digits) > 9:
        digits = digits[3:]
    if digits.startswith('0') and len(digits) > 8:
        digits = digits[1:]
    if len(digits) < 7 or len(digits) > 12:
        return None
    return digits

def get_service():
    token_data = json.load(open(TOKEN_FILE))
    creds_data = json.load(open(CREDS_FILE))
    client_info = creds_data.get('installed') or creds_data.get('web', {})
    creds = Credentials(
        token=token_data['access_token'],
        refresh_token=token_data['refresh_token'],
        token_uri=client_info.get('token_uri', 'https://oauth2.googleapis.com/token'),
        client_id=client_info['client_id'],
        client_secret=client_info['client_secret'],
        scopes=token_data.get('scope', '').split()
    )
    return build('sheets', 'v4', credentials=creds)

def load_contacts():
    """تحميل جهات الاتصال: رقم → اسم"""
    phone_to_name = {}
    with open(CONTACTS_FILE, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            first = row.get('First Name', '').strip()
            last = row.get('Last Name', '').strip()
            name = (first + ' ' + last).strip()
            name = re.sub(r'^["\'.،_\s]+|["\'.،_\s]+$', '', name)
            if not name:
                continue
            for key in ['Phone 1 - Value', 'Phone 2 - Value', 'Phone 3 - Value']:
                raw = row.get(key, '').strip()
                if raw:
                    cleaned = clean_phone(raw)
                    if cleaned and cleaned not in phone_to_name:
                        phone_to_name[cleaned] = name
    return phone_to_name

def main():
    service = get_service()
    sheet = service.spreadsheets()

    # 1. جلب جميع أسماء الأوراق
    print("📋 جلب قائمة الأوراق...")
    meta = sheet.get(spreadsheetId=SPREADSHEET_ID).execute()
    all_sheets = [s['properties']['title'] for s in meta['sheets']]
    print(f"  إجمالي الأوراق: {len(all_sheets)}")

    # 2. تحديد الأوراق اليومية والأرشيف
    daily_sheets = []
    for name in all_sheets:
        # أوراق يومية: دريمكس-2026-xx-xx أو نشامى-... أو السيف-...
        if re.search(r'(دريمكس|نشامى|السيف)-\d{4}-\d{2}-\d{2}', name):
            daily_sheets.append(name)
        elif 'أرشيف' in name:
            daily_sheets.append(name)
    print(f"  أوراق يومية/أرشيف: {len(daily_sheets)}")

    # 3. استخراج جميع الأرقام من الأوراق اليومية
    print("\n🔍 استخراج الأرقام من الأوراق اليومية...")
    all_phones_in_sheets = set()  # أرقام ظهرت في الأوراق اليومية
    phone_pushname = {}  # رقم → اسم واتساب (من عمود C في الأوراق اليومية)

    for sheet_name in daily_sheets:
        try:
            result = sheet.values().get(
                spreadsheetId=SPREADSHEET_ID,
                range=f"'{sheet_name}'!A:H"
            ).execute()
            rows = result.get('values', [])
            for row in rows[1:]:  # تخطي الرأس
                # عمود A: رقم الهاتف أو الاسم
                # نبحث عن أرقام في أي عمود
                for cell in row:
                    cleaned = clean_phone(str(cell))
                    if cleaned and len(cleaned) >= 8:
                        all_phones_in_sheets.add(cleaned)
        except Exception as e:
            pass  # تجاهل الأخطاء

    print(f"  أرقام فريدة في الأوراق اليومية: {len(all_phones_in_sheets)}")

    # 4. قراءة ورقة المسجلين
    print("\n📊 قراءة ورقة المسجلين...")
    result = sheet.values().get(
        spreadsheetId=SPREADSHEET_ID,
        range='المسجلين!A:D'
    ).execute()
    registered_rows = result.get('values', [])

    registered_phones = {}  # رقم → {row_index, name, lid}
    for i, row in enumerate(registered_rows):
        phone_raw = row[0].strip() if len(row) > 0 else ''
        name = row[1].strip() if len(row) > 1 else ''
        cleaned = clean_phone(phone_raw)
        if cleaned:
            registered_phones[cleaned] = {
                'row': i + 1,
                'name': name,
                'phone_raw': phone_raw
            }

    print(f"  أرقام مسجلة: {len(registered_phones)}")

    # 5. تحميل جهات الاتصال
    print("\n📂 تحميل جهات الاتصال...")
    contacts_map = load_contacts()
    print(f"  أرقام في جهات الاتصال: {len(contacts_map)}")

    # 6. إيجاد الأرقام الغائبة عن ورقة المسجلين
    missing = []
    for phone in all_phones_in_sheets:
        if phone not in registered_phones:
            contact_name = contacts_map.get(phone, '')
            missing.append({'phone': phone, 'name': contact_name})

    print(f"\n⚠️  أرقام موجودة في الأوراق اليومية لكن غير مسجلة: {len(missing)}")

    if not missing:
        print("✅ جميع الأرقام مسجلة!")
        return

    # عرض الأرقام الغائبة
    print("\nالأرقام الغائبة:")
    for m in missing[:30]:
        print(f"  {m['phone']} → {m['name'] or '(غير موجود في جهات الاتصال)'}")
    if len(missing) > 30:
        print(f"  ... و{len(missing)-30} آخرين")

    # 7. إضافة الأرقام الغائبة إلى ورقة المسجلين
    print(f"\n💾 إضافة {len(missing)} رقم إلى ورقة المسجلين...")

    # إيجاد آخر صف في ورقة المسجلين
    last_row = len(registered_rows) + 1

    new_rows = []
    for m in missing:
        new_rows.append([m['phone'], m['name'], '', ''])  # A=رقم, B=اسم, C=واتساب, D=LID

    # إضافة دفعي
    batch_size = 50
    added = 0
    for i in range(0, len(new_rows), batch_size):
        batch = new_rows[i:i+batch_size]
        start_row = last_row + i
        end_row = start_row + len(batch) - 1
        range_str = f'المسجلين!A{start_row}:D{end_row}'
        sheet.values().update(
            spreadsheetId=SPREADSHEET_ID,
            range=range_str,
            valueInputOption='RAW',
            body={'values': batch}
        ).execute()
        added += len(batch)
        print(f"  ✅ تم إضافة {added}/{len(new_rows)}")

    print(f"\n🎉 تم! تم إضافة {added} رقم جديد إلى ورقة المسجلين")
    print(f"   منهم {sum(1 for m in missing if m['name'])} لديهم اسم من جهات الاتصال")
    print(f"   و{sum(1 for m in missing if not m['name'])} بدون اسم (يمكنك إضافته لاحقاً)")

if __name__ == '__main__':
    main()
