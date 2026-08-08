#!/usr/bin/env python3
"""
إضافة أعضاء يدوياً إلى ورقة المسجلين
"""
import json
import os
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SPREADSHEET_ID = '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0'
SHEET_NAME = 'المسجلين'

# الأعضاء المراد إضافتهم: (رقم الهاتف، الاسم الرسمي)
NEW_MEMBERS = [
    ('778793241', 'محمد الحوراني'),
    ('799491887', 'سامح شقة'),
]

def get_service():
    token = json.load(open('./token.json'))
    creds = Credentials(
        token=token.get('access_token'),
        refresh_token=token.get('refresh_token'),
        token_uri='https://oauth2.googleapis.com/token',
        client_id=json.load(open('./oauth-credentials.json'))['installed']['client_id'],
        client_secret=json.load(open('./oauth-credentials.json'))['installed']['client_secret'],
        scopes=['https://www.googleapis.com/auth/spreadsheets']
    )
    return build('sheets', 'v4', credentials=creds)

def main():
    service = get_service()
    sheets = service.spreadsheets()
    
    # قراءة الأرقام الموجودة حالياً لتجنب التكرار
    result = sheets.values().get(
        spreadsheetId=SPREADSHEET_ID,
        range=f'{SHEET_NAME}!A:A'
    ).execute()
    existing_phones = set()
    for row in result.get('values', [])[1:]:  # تخطي الرأس
        if row:
            phone = str(row[0]).strip().replace('962', '').lstrip('0')
            if len(phone) >= 9:
                existing_phones.add(phone[-9:])
    
    print(f"📋 أرقام موجودة: {len(existing_phones)}")
    
    # تحضير الصفوف الجديدة
    rows_to_add = []
    for phone, name in NEW_MEMBERS:
        normalized = phone.strip().replace('962', '').lstrip('0')
        normalized = normalized[-9:] if len(normalized) >= 9 else normalized
        
        if normalized in existing_phones:
            print(f"⚠️  {phone} ({name}) موجود بالفعل — تخطي")
            continue
        
        rows_to_add.append([phone, name, '', ''])  # A=هاتف, B=اسم رسمي, C=اسم واتساب, D=LID
        print(f"➕ سيُضاف: {phone} — {name}")
    
    if not rows_to_add:
        print("✅ لا يوجد أعضاء جدد للإضافة")
        return
    
    # إضافة الصفوف في نهاية الورقة
    result = sheets.values().append(
        spreadsheetId=SPREADSHEET_ID,
        range=f'{SHEET_NAME}!A:D',
        valueInputOption='RAW',
        insertDataOption='INSERT_ROWS',
        body={'values': rows_to_add}
    ).execute()
    
    updated = result.get('updates', {}).get('updatedRows', 0)
    print(f"\n✅ تم إضافة {updated} عضو جديد بنجاح!")
    print(f"🔗 https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}")

if __name__ == '__main__':
    main()
