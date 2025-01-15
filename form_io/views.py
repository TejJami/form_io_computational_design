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
    print("Received request for OpenAI call")
    if request.method == 'POST':
        try:
            # Parse the request body for the prompt
            data = json.loads(request.body)
            prompt = data.get('prompt', '')

            print(f"Received prompt: {prompt}")

            if not prompt:
                return JsonResponse({"error": "No prompt provided"}, status=400)

            # Define inputs, their descriptions, ranges, and an example response
            inputs_description = {
                "podium_length": "Defines the length of the podium, which is typically the base or foundation on which the main structure (e.g., towers or buildings) is built. This parameter determines how far the podium extends along one axis. Should always be more than 20000mm.",
                "podium_width": "Specifies the width of the podium, determining its dimension along the perpendicular axis to the length. Together with podium_length, this creates the footprint of the podium. Should always be more than 20000mm.",
                "podium_no_of_floors": "Sets the number of floors or levels in the podium. This parameter controls the vertical extent of the podium structure. Output is always an integer.",
                "floor_height": "Determines the height of each floor in the building. This is a crucial parameter for calculating the total height of the structure and maintaining proportions.",
                "building_type": "Indicates the type of building being designed. This must be an integer from 0 to 5, where each number represents a specific type: 0 for single tower, 1 for two towers, 2 for courtyard, 3 for staggered, 4 for L-shaped, and 5 for H-shaped. This parameter may influence other design aspects such as floor layout and building regulations.",
                "tower_num_floors": "Specifies the number of floors in the tower portion of the model, controlling its vertical scale. This is separate from the podium and applies to the taller sections of the design.",
                "courtyard_offset": "Controls the distance or spacing for the courtyard area, typically affecting how much open space is left between the building and the inner courtyard. This is only applicable if the building type is 2 (courtyard).",
                "staggered_offset": "Defines the offset distance for staggered elements of the design. This parameter is often used for creating a stepped or terraced effect in the facade or building form. This is applicable only if the building type is 3 (staggered).",
                "polyline_offset": "Specifies the separation or spacing between two towers in the design. This ensures appropriate distances are maintained for structural, aesthetic, or functional reasons, such as light, air circulation, and privacy. This is applicable only when the building type is 1 (two towers)."
            }


            input_ranges = {
                "podium_length": [10000, 200000],
                "podium_width": [10000, 100000],
                "podium_no_of_floors": [1, 20],
                "floor_height": [2000, 5000],
                "building_type": [0, 5],
                "tower_num_floors": [1, 50],
                "courtyard_offset": [0, 10000],
                "staggered_offset": [0, 3000],
                "polyline_offset": [0, 20000]
            }

            example_response = {
            "parameters": {
                "courtyard_offset": "1090.88", 
                "podium_lenght": "47025.3210000", 
                "floor_height": "4941.268", 
                "podium_no_of_floors": "12.418", 
                "tower_num_floors": "8.536", 
                "staggered_offset": "7862.917", 
                "building_type": "H-shaped ]", 
                "two_tower_offset": "0.22", 
                "podium_width": "37701.2450000", 
                "polyline_offset": "8537.49400000"
            }, 
            "reasoning": "Explain why you made these parameter choices"
            }


            # Combine all details into the prompt
            detailed_prompt = (
                "You are an architect specializing in housing projects. Based on the given inputs, "
                "select parameter values for a project. Here are the details:\n\n"
                "Inputs and Descriptions:\n" +
                "\n".join([f"- {key}: {desc}" for key, desc in inputs_description.items()]) +
                "\n\nInput Ranges:\n" +
                "\n".join([f"- {key}: {value}" for key, value in input_ranges.items()]) +
                "\n\nExample JSON Response:\n" +
                json.dumps(example_response, indent=4) +
                f"\n\nNow, based on the following prompt, provide parameter values as a JSON response and always include all the values that are there in the example json, if not applicable then it should be 0:\n{prompt}"
            )

            # Call the OpenAI API
            response = client.chat.completions.create(
                model="gpt-4",
                messages=[
                    {"role": "system", "content": "You are an expert architect specialized in housing project configurations.Always reply in JSON format as in the example json. Do not include any other information in the response."},
                    {"role": "user", "content": detailed_prompt},
                ],
                max_tokens=800
            )
            print("OpenAI API call succeeded")
            print(f"Raw OpenAI Response: {response}")

            # Extract the content and parse as JSON if applicable
            gpt_output = response.choices[0].message.content
            print(f"gpt output Response: {gpt_output}")

            # Use the parsing helper function
            parameters = parse_openai_response(gpt_output)

            # Handle errors in parsing
            if "error" in parameters:
                return JsonResponse(parameters, status=500)

            # Send the extracted parameters to the frontend
            return JsonResponse({"parameters": parameters})
            
        except Exception as e:
            print(f"Error while calling OpenAI API: {e}")
            return JsonResponse({"error": str(e)}, status=500)

    return JsonResponse({"error": "Invalid request method"}, status=400)


def parse_openai_response(raw_response):
    """
    Parses the OpenAI JSON response to extract parameters and reasoning.
    """
    try:
        # Parse the JSON string
        parsed_response = json.loads(raw_response)

        # Extract "parameters" and "reasoning"
        parameters = parsed_response.get("parameters", {})
        reasoning = parsed_response.get("reasoning", "")

        # Return both as a dictionary
        return {"parameters": parameters, "reasoning": reasoning}
    except json.JSONDecodeError as e:
        print(f"Error parsing OpenAI JSON response: {e}")
        return {"error": "Invalid JSON format in OpenAI response."}
