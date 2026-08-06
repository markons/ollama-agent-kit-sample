from ollama import chat, ChatResponse
import subprocess

# --- 1. Define the Tool (Windows command) ---
def get_windows_info(info_type: str) -> str:
    """
    Get information about the Windows system.

    Args:
        info_type: The type of information requested. Can be "model" or "os".
    """
    if info_type == "model":
        # Run the WMIC command to get the model
        result = subprocess.run(
            ["wmic", "computersystem", "get", "model,manufacturer"],
            capture_output=True,
            text=True
        )
        return result.stdout
    elif info_type == "os":
        # Run the systeminfo command to get OS info
        result = subprocess.run(
            ["systeminfo", "|", "findstr", "/B", "/C:\"OS Name\""],
            shell=True,
            capture_output=True,
            text=True
        )
        return result.stdout
    else:
        return "Unknown info type"

# Map the function name for the model to call
available_functions = {
    'get_windows_info': get_windows_info,
}

# --- 2. Start the Agent Loop ---
messages = [{'role': 'user', 'content': 'What is the model of my PC?'}]

while True:
    # Send the conversation and tools to the model
    response: ChatResponse = chat(
        model='granite4:350m',  # Or your chosen model
        messages=messages,
        tools=[get_windows_info],  # Pass the function itself
        think=True,  # Optional: see the model's reasoning
    )

    messages.append(response.message)

    # --- 3. Check if the model wants to call a tool ---
    if response.message.tool_calls:
        for tool_call in response.message.tool_calls:
            # Get the function name and arguments
            function_name = tool_call.function.name
            function_args = tool_call.function.arguments
            
            # --- 4. Execute the tool ---
            if function_name in available_functions:
                print(f"Calling {function_name} with arguments {function_args}")
                function_to_call = available_functions[function_name]
                result = function_to_call(**function_args)
                print(f"Result: {result}")
                
                # --- 5. Send the result back to the model ---
                messages.append({
                    'role': 'tool',
                    'tool_name': function_name,
                    'content': str(result)
                })
    else:
        # If the model didn't call any tool, the task is complete
        break

# Print the final answer
print("\nFinal Answer:", response.message.content)