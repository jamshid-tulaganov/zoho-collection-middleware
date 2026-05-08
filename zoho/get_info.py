import requests
import json
import sys

CLIENT_ID     = "1000.4SYEBEAVK7CAXYJKJQPEHQRC9HAF9B"
CLIENT_SECRET = "be30b925915dc602f5ae7d174b0d81980b4a8bc1df"
REFRESH_TOKEN = "1000.45292ecb885f163a02e20b0077bf1f31.3d0307403dced31df56bd25fd6dd7d94"
ACCOUNTS_URL  = "https://accounts.zoho.com"
SANDBOX_URL   = "https://sandbox.zohoapis.com"
REDIRECT_URI  = "http://localhost"
MODULE        = "Collection_Cases"

SCOPE = "ZohoCRM.settings.ALL,ZohoCRM.modules.ALL"


def print_auth_url():
    from urllib.parse import urlencode
    params = {
        "scope":         SCOPE,
        "client_id":     CLIENT_ID,
        "response_type": "code",
        "access_type":   "offline",
        "redirect_uri":  REDIRECT_URI,
    }
    url = f"{ACCOUNTS_URL}/oauth/v2/auth?" + urlencode(params)
    print("\nVisit this URL while logged into your Zoho SANDBOX account:")
    print(f"\n  {url}\n")
    print("After you allow access, you'll be redirected to localhost.")
    print("Copy the `code=` value from the URL and run:")
    print("  python3 zoho/get_info.py exchange <code>\n")


def exchange_code(code):
    resp = requests.post(f"{ACCOUNTS_URL}/oauth/v2/token", params={
        "code":          code,
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type":    "authorization_code",
    })
    resp.raise_for_status()
    data = resp.json()
    print(json.dumps(data, indent=2))
    if "refresh_token" in data:
        print("\nSave this refresh_token in the script as REFRESH_TOKEN.")


def get_access_token():
    resp = requests.post(f"{ACCOUNTS_URL}/oauth/v2/token", params={
        "refresh_token": REFRESH_TOKEN,
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type":    "refresh_token",
    })
    resp.raise_for_status()
    data = resp.json()
    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"No access_token: {data}")
    return token


def get_fields(token, module=MODULE):
    resp = requests.get(
        f"{SANDBOX_URL}/crm/v2/settings/fields",
        params={"module": module},
        headers={"Authorization": f"Zoho-oauthtoken {token}"},
    )
    if not resp.ok:
        print(f"Error {resp.status_code}: {resp.text}")
        resp.raise_for_status()
    return resp.json()


def run():
    print("Refreshing token...")
    token = get_access_token()
    print(f"Token: {token[:20]}...\n")

    print(f"Fetching fields for sandbox module: {MODULE}")
    data = get_fields(token)

    fields = data.get("fields", [])
    print(f"\nTotal fields: {len(fields)}\n")
    print(f"{'API Name':<45} {'Label':<40} {'Type':<20} {'Required'}")
    print("-" * 115)
    for f in fields:
        print(f"{f['api_name']:<45} {f['field_label']:<40} {f['data_type']:<20} {f.get('system_mandatory', False)}")

    out = "zoho/collection_cases_fields.json"
    with open(out, "w") as fp:
        json.dump(data, fp, indent=2)
    print(f"\nFull response saved to {out}")


if __name__ == "__main__":
    if len(sys.argv) == 1:
        run()
    elif sys.argv[1] == "auth":
        print_auth_url()
    elif sys.argv[1] == "exchange" and len(sys.argv) == 3:
        exchange_code(sys.argv[2])
    else:
        print("Usage:")
        print("  python3 zoho/get_info.py          # fetch fields (needs sandbox refresh token)")
        print("  python3 zoho/get_info.py auth      # print OAuth URL to authorize sandbox")
        print("  python3 zoho/get_info.py exchange <code>  # exchange code for tokens")
