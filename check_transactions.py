import json
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

with open('token.json') as f:
    token = json.load(f)
with open('oauth-credentials.json') as f:
    creds_data = json.load(f)

ci = creds_data.get('installed') or creds_data.get('web', {})
creds = Credentials(
    token=token.get('access_token'),
    refresh_token=token.get('refresh_token'),
    token_uri='https://oauth2.googleapis.com/token',
    client_id=ci.get('client_id'),
    client_secret=ci.get('client_secret'),
    scopes=['https://www.googleapis.com/auth/spreadsheets']
)
if creds.expired:
    creds.refresh(Request())

service = build('sheets', 'v4', credentials=creds)
SPREADSHEET_ID = '15gDbpqB0e8BwX5G8S9QqCeUPg8WLZPpYukSF1mHplp0'

# Read transactions sheet
result = service.spreadsheets().values().get(
    spreadsheetId=SPREADSHEET_ID,
    range="سجل الحركات!A1:J10"
).execute()
rows = result.get('values', [])
print(f"سجل الحركات - أول 10 صفوف:")
for i, row in enumerate(rows):
    print(f"  Row {i}: {row}")

print()

# Check edit log sheet
result2 = service.spreadsheets().values().get(
    spreadsheetId=SPREADSHEET_ID,
    range="سجل التعديلات!A1:H5"
).execute()
rows2 = result2.get('values', [])
print(f"سجل التعديلات - أول 5 صفوف:")
for i, row in enumerate(rows2):
    print(f"  Row {i}: {row}")
