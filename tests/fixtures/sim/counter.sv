// fig-gen test fixture (self-written): a 4-bit counter with enable and a wrap flag.
module counter (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       en,
  output logic [3:0] count,
  output logic       wrap
);
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) count <= 4'd0;
    else if (en) count <= count + 4'd1;
  end
  assign wrap = en && count == 4'hf;
endmodule
