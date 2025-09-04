# skyTrail

**skyTrail** is an experimental visualization tool that explores how flight data can be represented through generative design.  
The application takes as input a dataset containing aircraft information (such as timestamp, altitude, speed, and position) and transforms it into interactive visualizations, including rosette-style timelines, speed charts, and minimaps.

## Required Data

To work properly, skyTrail requires structured flight data (in CSV format) with at least:

- **Timestamp** (when each data point was recorded, in Unix Epoch Time)
- **Location** (lat,lon)
- **Speed** (knots)
- **Altitude** (feet)
- **Heading** (deg)

## Live website

Try SkyTrail here: https://giovannimalausa.github.io/skyTrail/.

## Sample Data

The [_Sample CSVs_](Sample%20CSVs/) folder contains:

- [**EK88_3bae98e4.csv**](Sample%20CSVs/EK88_3bae98e4.csv) (long flight, eastbound, incomplete data)
- [**EK93_3bd5a240.csv**](Sample%20CSVs/EK93_3bd5a240.csv) (long flight, westbound)
- [**LX1661_3be1d3f4.csv**](Sample%20CSVs/LX1661_3be1d3f4.csv) (short flight, westbound)

## Context

This project was developed for the _Shapes and Algorithms_ course at Politecnico di Milano, and serves as a study on how algorithms can turn numerical datasets into meaningful, visual narratives.
