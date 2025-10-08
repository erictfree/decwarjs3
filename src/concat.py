import os

# Get the current directory
current_dir = os.getcwd()

# List to hold all .ts files
ts_files = []

# Walk through the directory, limiting to depth 1
for root, dirs, files in os.walk(current_dir):
    # Calculate the depth
    depth = os.path.relpath(root, current_dir).count(os.sep)
    if depth > 1:
        continue  # Skip directories deeper than 1 level
    
    for file in files:
        if file.endswith('.ts'):
            ts_files.append(os.path.join(root, file))

# Sort the files alphabetically by their full path
ts_files.sort()

# Open the output file
with open('source.txt', 'w') as outfile:
    for file_path in ts_files:
        # Get the relative filename (e.g., 'subdir/util.ts' or 'util.ts')
        rel_filename = os.path.relpath(file_path, current_dir)
        
        # Write the header
        outfile.write(f"######## {rel_filename}\n")
        
        # Read and write the content of the file
        with open(file_path, 'r') as infile:
            outfile.write(infile.read())
        
        # Add a newline separator after each file's content
        outfile.write("\n")
