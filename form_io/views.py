import requests
import base64
import json
import os
from django.http import JsonResponse
from django.conf import settings
from django.views.decorators.csrf import csrf_exempt
from django.shortcuts import render, redirect
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404


def index(request):
    return render(request, 'form_io/index.html')

def solve_grasshopper(request):
    if request.method == "POST":
        try:
            # 1. Collect Parameters
            gh_file_name = request.POST.get("grasshopper_file_name")
            inputs = json.loads(request.POST.get("input_data", "{}"))
            print("Inputs received:", inputs)

            # Locate Grasshopper definition
            gh_file_path = os.path.join(settings.GRASSHOPPER_FILES_DIR, gh_file_name)
            if not os.path.exists(gh_file_path):
                return JsonResponse({"success": False, "error": f"File {gh_file_name} not found."})

            # 2. Encode Grasshopper File
            with open(gh_file_path, "rb") as gh_file:
                gh_data = gh_file.read()
                encoded = base64.b64encode(gh_data).decode()  # Keep it as Base64-encoded string

            # 3. Prepare Inputs
            values = []
            for param_name, param_value in inputs.items():
                inner_tree = {
                    "{0;0}": [
                        {
                            "type": "System.Double" if isinstance(param_value, (float, int)) else "System.String",
                            "data": param_value,
                        }
                    ]
                }
                values.append({"ParamName": param_name, "InnerTree": inner_tree})

            # 4. Send Request to Rhino Compute
            post_url = "http://localhost:6001/grasshopper"
            payload = {"algo": encoded, "pointer": None, "values": values}
            response = requests.post(post_url, json=payload)

            if response.status_code != 200:
                print("Compute server error:", response.text)
                return JsonResponse({"success": False, "error": response.text}, status=response.status_code)

            # 5. Parse and Return Result
            res_data = response.json()
            return JsonResponse(res_data)

        except Exception as e:
            print("Error in solve_grasshopper:", str(e))
            return JsonResponse({"success": False, "error": str(e)}, status=500)

    return JsonResponse({"success": False, "error": "Only POST method allowed."})


from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from openai import OpenAI

import json

from dotenv import load_dotenv
import os

# Load environment variables
load_dotenv()

# Access the API key
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY_1")

# Initialize the OpenAI client
client = OpenAI(api_key=OPENAI_API_KEY)

@csrf_exempt
def chat_with_openai(request):
    if request.method == 'POST':
        try:
            # Parse the request body for the prompt
            data = json.loads(request.body)
            prompt = data.get('prompt', '')

            if not prompt:
                return JsonResponse({"error": "No prompt provided"}, status=400)

            # Call the OpenAI API
            response = client.chat.completions.create(
                model="gpt-3.5-turbo",
                messages=[
                    {"role": "system", "content": "Act as an expert in parametric design."},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=800,
            )

            # Extract the content and parse as JSON if applicable
            gpt_output = response["choices"][0]["message"]["content"]
            try:
                response_json = json.loads(gpt_output)  # Validate JSON response from OpenAI
            except json.JSONDecodeError:
                return JsonResponse({"error": "Invalid JSON format in OpenAI response."}, status=500)

            return JsonResponse(response_json)

        except Exception as e:
            return JsonResponse({"error": str(e)}, status=500)

    return JsonResponse({"error": "Invalid request method"}, status=400)
