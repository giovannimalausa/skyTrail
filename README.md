# skyTrail

**skyTrail** is an experimental visualization tool that explores how flight data can be represented through generative design.  
The application takes as input a dataset containing aircraft information (such as timestamp, altitude, speed, and position) and transforms it into interactive visualizations, including rosette-style timelines, speed charts, and minimaps.

To work properly, skyTrail requires structured flight data (CSV or equivalent) with at least:

- **Timestamp** (when each data point was recorded, in Unix Epoch Time)
- **Location** (lat,lon)
- **Speed** (knots)
- **Altitude** (feet)
- **Heading** (deg)

This project was developed for the _Shapes and Algorithms_ course at Politecnico di Milano, and serves as a study on how algorithms can turn numerical datasets into meaningful, visual narratives.
